//! Host harness: spice-lite as a guest of the SpaceWasm interpreter.
//!
//! Loads `build/spice_lite.wasm` with the `spacewasm` crate, copies a blob into guest
//! memory, and runs a list of queries (the same text format the test vectors use). For
//! each query it prints the status the library returned and the number of interpreter
//! instructions the call executed. The count is exact: the interpreter is given one
//! instruction of fuel at a time, so the number of resumptions is the number of
//! instructions.
//!
//! Usage: spice-lite-spacewasm-host --module <wasm> --blob <slb> --base <addr>
//!          --queries <file>
//!
//! `--base` is the guest address to place the blob at (the module's `__heap_base`,
//! rounded up to 8). The module must declare enough memory to hold the blob and a
//! small scratch area after it.

use spacewasm::{
    CodeBuilder, CompilerOptions, ControlFrame, DecoderStack, Engine, ExportDesc, InnerVec,
    Interpreter, InterpreterResult, InterpreterRunner, Module, ModuleRef, OperandType, Ref, Value,
    WasmMemoryAllocator, WasmRef, WasmStream,
};
use std::alloc::Layout;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Operand and call stack for the interpreter, in 32-bit words. F Prime's default.
const STACK_WORDS: usize = 1024;
const MAX_CODE_PAGES: usize = 1024;
const DECODER_FRAMES: usize = 64;
const DECODER_DEPTH: usize = 256;

static HEAP_LIVE: AtomicUsize = AtomicUsize::new(0);
static HEAP_PEAK: AtomicUsize = AtomicUsize::new(0);

struct CountingHeap;

// SAFETY: forwards to the Rust global allocator, which upholds the same contract.
unsafe impl spacewasm::Allocator for CountingHeap {
    unsafe fn alloc(&self, layout: Layout) -> Result<*mut u8, spacewasm::AllocError> {
        if layout.size() == 0 {
            return Ok(layout.align() as *mut u8);
        }
        // SAFETY: non-zero size, checked above.
        let ptr = unsafe { std::alloc::alloc(layout) };
        if ptr.is_null() {
            return Err(spacewasm::AllocError::AllocationFailed);
        }
        let live = HEAP_LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        HEAP_PEAK.fetch_max(live, Ordering::Relaxed);
        Ok(ptr)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        if layout.size() == 0 || ptr.is_null() {
            return;
        }
        // SAFETY: `ptr` came from `alloc` with `layout`.
        unsafe { std::alloc::dealloc(ptr, layout) };
        HEAP_LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

spacewasm::global_allocator!(CountingHeap, CountingHeap);

struct LinearMemory;

impl WasmMemoryAllocator for LinearMemory {
    fn allocate(&self, layout: Layout) -> Result<NonNull<u8>, spacewasm::AllocError> {
        if layout.size() == 0 {
            return Ok(NonNull::dangling());
        }
        // SAFETY: non-zero size, checked above.
        NonNull::new(unsafe { std::alloc::alloc_zeroed(layout) })
            .ok_or(spacewasm::AllocError::AllocationFailed)
    }

    fn reallocate(
        &self,
        ptr: NonNull<u8>,
        old_layout: Layout,
        layout: Layout,
    ) -> Result<NonNull<u8>, spacewasm::AllocError> {
        if old_layout.size() == 0 {
            return self.allocate(layout);
        }
        // SAFETY: `ptr` came from `allocate` or `reallocate` with `old_layout`.
        NonNull::new(unsafe { std::alloc::realloc(ptr.as_ptr(), old_layout, layout.size()) })
            .ok_or(spacewasm::AllocError::AllocationFailed)
    }

    fn deallocate(&self, ptr: NonNull<u8>, layout: Layout) {
        if layout.size() != 0 {
            // SAFETY: `ptr` came from `allocate` or `reallocate` with `layout`.
            unsafe { std::alloc::dealloc(ptr.as_ptr(), layout) }
        }
    }
}

/// The whole module handed to the decoder as one chunk.
struct Slice<'a> {
    bytes: &'a [u8],
    done: bool,
}

impl WasmStream for Slice<'_> {
    fn read(&mut self) -> Result<Option<InnerVec<u8>>, u8> {
        if self.done {
            return Ok(None);
        }
        self.done = true;
        // SAFETY: the decoder only reads through the view, and `self.bytes` outlives it.
        Ok(Some(unsafe {
            InnerVec::from_raw_parts(
                self.bytes.as_ptr().cast_mut(),
                self.bytes.len(),
                self.bytes.len(),
            )
        }))
    }

    fn return_(&mut self, _: InnerVec<u8>) {}
}

type Res<T> = Result<T, Box<dyn std::error::Error>>;

struct Host {
    engine: Engine,
    code: CodeBuilder,
    module: ModuleRef,
}

impl Host {
    fn load(bytes: &[u8]) -> Res<(Host, usize, usize)> {
        let heap_before = HEAP_LIVE.load(Ordering::Relaxed);
        let mut code = CodeBuilder::new(CompilerOptions::new(false, None, MAX_CODE_PAGES))
            .map_err(|err| format!("could not allocate the code pages: {err:?}"))?;
        let mut engine = Engine::new(STACK_WORDS, 1, spacewasm::vec![])
            .map_err(|err| format!("could not create the interpreter: {err:?}"))?;
        let memory = spacewasm::Rc::new(LinearMemory)
            .map_err(|err| format!("out of memory: {err:?}"))?
            .into_wasm_memory_allocator();
        let mut control_frames = vec![ControlFrame::EMPTY; DECODER_FRAMES];
        let mut operands = vec![OperandType::EMPTY; DECODER_DEPTH];
        let module = Module::new(
            "spice_lite",
            &mut Slice { bytes, done: false },
            &mut engine.store,
            &mut code,
            &mut DecoderStack::new(&mut control_frames, &mut operands),
            memory,
        )
        .map_err(|err| {
            format!("the module does not load at byte {:#x}: {:?}", err.offset, err.err.err)
        })?;
        let module = engine
            .push_module(module)
            .map_err(|err| format!("could not instantiate the module: {err:?}"))?;
        let pages = code.pages().len();
        let ir_words = pages.saturating_sub(1) * 256 + code.offset();
        let heap = HEAP_LIVE.load(Ordering::Relaxed) - heap_before;
        Ok((Host { engine, code, module }, ir_words, heap))
    }

    fn export(&self, name: &str) -> Res<WasmRef> {
        let module = &self.engine.store.modules()[self.module.0 as usize];
        let export = module
            .exports
            .iter()
            .find(|export| export.name == name)
            .ok_or_else(|| format!("the module does not export `{name}`"))?;
        let ExportDesc::Func(index) = export.desc else {
            return Err(format!("`{name}` is not a function").into());
        };
        match module.get_func_ref(index) {
            Some(Ref::Module(index)) => Ok(WasmRef { module: self.module, index }),
            _ => Err(format!("`{name}` is not defined by the module").into()),
        }
    }

    /// Runs one export to completion, one instruction of fuel at a time. Returns the
    /// function's result and the number of instructions executed.
    fn call(&mut self, name: &str, args: &[Value]) -> Res<(i32, u64)> {
        let f = self.export(name)?;
        self.engine.invoke(f, args).map_err(|err| format!("could not invoke {name}: {err:?}"))?;
        let mut instructions = 0u64;
        loop {
            match Interpreter.run(self.code.pages(), &mut self.engine, 1) {
                InterpreterResult::OutOfFuel => instructions += 1,
                InterpreterResult::Finished => break,
                other => return Err(format!("{name} did not finish: {other:?}").into()),
            }
        }
        let status = self.engine.result.map(|raw| raw.read_64()).unwrap_or(0) as i32;
        Ok((status, instructions))
    }

    fn write(&self, addr: u32, data: &[u8]) -> Res<()> {
        self.engine
            .store
            .get_memory(self.module)
            .store(addr as usize, data)
            .map_err(|err| format!("guest memory write at {addr:#x} failed: {err:?}").into())
    }

    fn memory_bytes(&self) -> usize {
        self.engine.store.get_memory(self.module).get_slice().len()
    }
}

fn hex_f64(s: &str) -> Res<f64> {
    Ok(f64::from_bits(u64::from_str_radix(s, 16)?))
}

fn arg<'a>(args: &'a [String], name: &str) -> Res<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .ok_or_else(|| format!("missing {name}").into())
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    let module = std::fs::read(arg(&args, "--module")?)?;
    let blob = std::fs::read(arg(&args, "--blob")?)?;
    let base: u32 = arg(&args, "--base")?.parse()?;
    let queries = std::fs::read_to_string(arg(&args, "--queries")?)?;

    let (mut host, ir_words, heap) = Host::load(&module)?;
    let out = (base + blob.len() as u32 + 7) & !7;
    if (out as usize) + 256 > host.memory_bytes() {
        return Err(format!(
            "guest memory is {} bytes; the blob at {base:#x} plus scratch needs {}",
            host.memory_bytes(),
            out + 256
        )
        .into());
    }
    host.write(base, &blob)?;
    println!(
        "{{\"load\":{{\"module_bytes\":{},\"ir_words\":{ir_words},\"ir_bytes\":{},\"heap_bytes\":{heap},\"stack_words\":{STACK_WORDS},\"guest_memory_bytes\":{}}}}}",
        module.len(),
        ir_words * 2,
        host.memory_bytes()
    );

    let i = |v: &str| -> Res<Value> { Ok(Value::I32(v.parse::<i64>()? as i32)) };
    let p = |addr: u32| Value::I32(addr as i32);
    for line in queries.lines() {
        let t: Vec<&str> = line.split_whitespace().collect();
        if t.is_empty() || t[0].starts_with('#') {
            continue;
        }
        let (status, n) = match t[0] {
            "init" => host.call("lite_init", &[p(base), Value::I32(blob.len() as i32), i(t[1])?])?,
            "host2et" => host.call("lite_host2et", &[i(t[1])?, i(t[2])?, i(t[3])?, p(out)])?,
            "fwtime" => {
                let bytes: Vec<u8> = (0..t[1].len() / 2)
                    .map(|k| u8::from_str_radix(&t[1][2 * k..2 * k + 2], 16))
                    .collect::<Result<_, _>>()?;
                host.write(out + 64, &bytes)?;
                host.call("lite_fwtime2et", &[p(out + 64), Value::I32(bytes.len() as i32), p(out)])?
            }
            "state" => host.call(
                "lite_state",
                &[i(t[1])?, i(t[2])?, Value::F64(hex_f64(t[3])?), i(t[4])?, p(out), p(out + 48), p(out + 56)],
            )?,
            "setstate" => {
                let mut data = Vec::new();
                for k in 0..6 {
                    data.extend_from_slice(&hex_f64(t[4 + k])?.to_le_bytes());
                }
                host.write(out, &data)?;
                host.call(
                    "lite_set_state",
                    &[i(t[1])?, i(t[2])?, Value::F64(hex_f64(t[3])?), p(out), Value::F64(hex_f64(t[10])?)],
                )?
            }
            "clearstate" => host.call("lite_clear_state", &[])?,
            "gap" => host.call("lite_state_gap", &[Value::F64(hex_f64(t[1])?), p(out), p(out + 8)])?,
            "orient" => host.call("lite_orient", &[i(t[1])?, Value::F64(hex_f64(t[2])?), p(out)])?,
            "siteview" => host.call(
                "lite_site_view",
                &[i(t[1])?, i(t[2])?, Value::F64(hex_f64(t[3])?), i(t[4])?, p(out), p(out + 8), p(out + 16)],
            )?,
            "subpoint" => host.call(
                "lite_sub_point",
                &[i(t[1])?, i(t[2])?, Value::F64(hex_f64(t[3])?), p(out), p(out + 8), p(out + 16)],
            )?,
            "occulted" => host.call(
                "lite_occulted",
                &[i(t[1])?, i(t[2])?, i(t[3])?, Value::F64(hex_f64(t[4])?), p(out)],
            )?,
            other => return Err(format!("unknown query `{other}`").into()),
        };
        println!("{{\"query\":\"{}\",\"status\":{status},\"instructions\":{n}}}", line.trim());
    }
    println!("{{\"heap_peak_bytes\":{}}}", HEAP_PEAK.load(Ordering::Relaxed));
    Ok(())
}
