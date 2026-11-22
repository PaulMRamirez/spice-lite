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
//!
//! A second mode runs a whole sequence the way the F Prime WasmSequencer would:
//!
//!   spice-lite-spacewasm-host --sequence --module <wasm> --start-seconds <n>
//!
//! It binds stand-ins for the sequencer's `fprime_v1` host calls (time, event, cmd,
//! rsleep, exit) over a simulated spacecraft clock, invokes the module's `main`, and
//! prints one JSON line per event, command, and sleep, each with the exact number of
//! instructions the guest executed since the previous sleep. A sleep pauses the
//! interpreter, as it does in the sequencer, and the simulated clock jumps forward by
//! the requested amount before the guest resumes.

use spacewasm::{
    CodeBuilder, CompilerOptions, ControlFrame, DecoderStack, Engine, ExportDesc, HostFunction,
    HostFunctionBreak, HostModule, InnerVec, Interpreter, InterpreterResult, InterpreterRunner,
    Module, ModuleRef, OperandType, Ref, Value, WasmMemoryAllocator, WasmRef, WasmStream,
};
use std::alloc::Layout;
use std::cell::{Cell, RefCell};
use std::ops::ControlFlow;
use std::rc::Rc;
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
    fn load(bytes: &[u8], host_modules: spacewasm::Vec<HostModule>) -> Res<(Host, usize, usize)> {
        let heap_before = HEAP_LIVE.load(Ordering::Relaxed);
        let mut code = CodeBuilder::new(CompilerOptions::new(false, None, MAX_CODE_PAGES))
            .map_err(|err| format!("could not allocate the code pages: {err:?}"))?;
        let mut engine = Engine::new(STACK_WORDS, 1, host_modules)
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

/// What the stand-in host calls share: the simulated spacecraft clock, the running
/// instruction count, and the log of what the sequence did.
struct Sim {
    clock_us: Cell<u64>,
    instructions: Cell<u64>,
    cycle_start: Cell<u64>,
    sleep_us: Cell<u64>,
    exit_code: Cell<Option<i32>>,
    lines: RefCell<Vec<String>>,
}

impl Sim {
    fn since_sleep(&self) -> u64 {
        self.instructions.get() - self.cycle_start.get()
    }

    fn log(&self, kind: &str, detail: String) {
        self.lines.borrow_mut().push(format!(
            "{{\"kind\":\"{kind}\",\"host_seconds\":{:.6},\"instructions_since_sleep\":{}{detail}}}",
            self.clock_us.get() as f64 / 1e6,
            self.since_sleep()
        ));
    }
}

fn arg_i32(v: Option<&Value>) -> i32 {
    match v {
        Some(Value::I32(x)) => *x,
        other => panic!("host call expected an i32 argument, got {other:?}"),
    }
}

/// Stand-ins for the WasmSequencer host calls a sequence imports from `fprime_v1`.
fn fprime_host_module(sim: &Rc<Sim>) -> HostModule {
    let time = {
        let sim = Rc::clone(sim);
        HostFunction::new("time", "ii".into(), "".into(), move |state, args| {
            let (ptr, size) = (arg_i32(args.first()) as u32, arg_i32(args.get(1)) as u32);
            if size != 11 {
                return ControlFlow::Break(HostFunctionBreak::Trap);
            }
            // Fw::Time in its default layout: base TB_SC_TIME (3), context 0, seconds,
            // microseconds, big-endian.
            let us = sim.clock_us.get();
            let mut bytes = [0u8; 11];
            bytes[1] = 3;
            bytes[3..7].copy_from_slice(&((us / 1_000_000) as u32).to_be_bytes());
            bytes[7..11].copy_from_slice(&((us % 1_000_000) as u32).to_be_bytes());
            match state.memory.store(ptr as usize, &bytes) {
                Ok(()) => ControlFlow::Continue(None),
                Err(_) => ControlFlow::Break(HostFunctionBreak::Trap),
            }
        })
    };
    let event = {
        let sim = Rc::clone(sim);
        HostFunction::new("event", "iii".into(), "".into(), move |state, args| {
            let severity = arg_i32(args.first());
            let (ptr, size) = (arg_i32(args.get(1)) as u32, arg_i32(args.get(2)) as u32);
            let Ok(raw) = state.memory.load(ptr as usize, size as usize) else {
                return ControlFlow::Break(HostFunctionBreak::Trap);
            };
            let text: String = String::from_utf8_lossy(raw)
                .chars()
                .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
                .collect();
            sim.log("event", format!(",\"severity\":{severity},\"text\":\"{text}\""));
            ControlFlow::Continue(None)
        })
    };
    let cmd = {
        let sim = Rc::clone(sim);
        HostFunction::new("cmd", "ii".into(), "i".into(), move |state, args| {
            let (ptr, size) = (arg_i32(args.first()) as u32, arg_i32(args.get(1)) as u32);
            let Ok(raw) = state.memory.load(ptr as usize, size as usize) else {
                return ControlFlow::Break(HostFunctionBreak::Trap);
            };
            let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
            sim.log("command", format!(",\"bytes\":\"{hex}\""));
            ControlFlow::Continue(Some(Value::I32(0)))
        })
    };
    let rsleep = {
        let sim = Rc::clone(sim);
        HostFunction::new("rsleep", "I".into(), "".into(), move |_, args| {
            let us = match args.first() {
                Some(Value::I64(x)) => *x as u64,
                other => panic!("rsleep expected an i64 argument, got {other:?}"),
            };
            sim.sleep_us.set(us);
            ControlFlow::Break(HostFunctionBreak::Pause)
        })
    };
    let exit = {
        let sim = Rc::clone(sim);
        HostFunction::new("exit", "i".into(), "".into(), move |_, args| {
            sim.exit_code.set(Some(arg_i32(args.first())));
            ControlFlow::Break(HostFunctionBreak::Trap)
        })
    };
    HostModule {
        name: "fprime_v1".into(),
        globals: spacewasm::vec![],
        functions: spacewasm::vec![time, event, cmd, rsleep, exit],
        memory: spacewasm::Vec::zero(),
        table: spacewasm::Vec::zero(),
    }
}

/// Runs a sequence module's `main` to its exit over the simulated clock.
fn run_sequence(args: &[String]) -> Res<()> {
    let module = std::fs::read(arg(args, "--module")?)?;
    let start: u64 = arg(args, "--start-seconds")?.parse()?;
    let sim = Rc::new(Sim {
        clock_us: Cell::new(start * 1_000_000),
        instructions: Cell::new(0),
        cycle_start: Cell::new(0),
        sleep_us: Cell::new(0),
        exit_code: Cell::new(None),
        lines: RefCell::new(Vec::new()),
    });
    let (mut host, ir_words, heap) = Host::load(&module, spacewasm::vec![fprime_host_module(&sim)])?;
    println!(
        "{{\"kind\":\"load\",\"module_bytes\":{},\"ir_bytes\":{},\"heap_bytes\":{heap},\"guest_memory_bytes\":{}}}",
        module.len(),
        ir_words * 2,
        host.memory_bytes()
    );
    let main = host.export("main")?;
    host.engine.invoke(main, &[]).map_err(|err| format!("could not invoke main: {err:?}"))?;
    let mut sleeps = 0u64;
    loop {
        match Interpreter.run(host.code.pages(), &mut host.engine, 1) {
            InterpreterResult::OutOfFuel => sim.instructions.set(sim.instructions.get() + 1),
            InterpreterResult::Pause => {
                let us = sim.sleep_us.get();
                sim.log("sleep", format!(",\"sleep_seconds\":{:.6}", us as f64 / 1e6));
                sim.clock_us.set(sim.clock_us.get() + us);
                sim.cycle_start.set(sim.instructions.get());
                sleeps += 1;
                host.engine.resume(None).map_err(|err| format!("could not resume: {err:?}"))?;
            }
            InterpreterResult::Finished => break,
            other => {
                if sim.exit_code.get().is_some() {
                    break;
                }
                return Err(format!("the sequence did not finish: {other:?}").into());
            }
        }
    }
    for line in sim.lines.borrow().iter() {
        println!("{line}");
    }
    println!(
        "{{\"kind\":\"exit\",\"code\":{},\"host_seconds\":{:.6},\"sleeps\":{sleeps},\"instructions_total\":{},\"instructions_since_sleep\":{}}}",
        sim.exit_code.get().map_or("null".to_string(), |c| c.to_string()),
        sim.clock_us.get() as f64 / 1e6,
        sim.instructions.get(),
        sim.since_sleep()
    );
    Ok(())
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--sequence") {
        return run_sequence(&args);
    }
    let module = std::fs::read(arg(&args, "--module")?)?;
    let blob = std::fs::read(arg(&args, "--blob")?)?;
    let base: u32 = arg(&args, "--base")?.parse()?;
    let queries = std::fs::read_to_string(arg(&args, "--queries")?)?;

    let (mut host, ir_words, heap) = Host::load(&module, spacewasm::vec![])?;
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
            "occcorr" => host.call(
                "lite_occulted_corr",
                &[i(t[1])?, i(t[2])?, i(t[3])?, Value::F64(hex_f64(t[4])?), i(t[5])?, p(out), p(out + 4), p(out + 8)],
            )?,
            other => return Err(format!("unknown query `{other}`").into()),
        };
        println!("{{\"query\":\"{}\",\"status\":{status},\"instructions\":{n}}}", line.trim());
    }
    println!("{{\"heap_peak_bytes\":{}}}", HEAP_PEAK.load(Ordering::Relaxed));
    Ok(())
}
