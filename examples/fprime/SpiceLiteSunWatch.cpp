// A test for F Prime's Svc/WasmSequencer unit-test suite that runs the spice-lite
// demonstration sequence inside the real component. It is not part of F Prime and
// is kept here so the run described in docs/fprime-integration.md can be repeated.
//
// To use it: append this file's contents to
// Svc/WasmSequencer/test/ut/WasmSequencerTestMain.cpp inside `namespace Svc { }`,
// copy build/sun_watch.wasm to Svc/WasmSequencer/test/wasm/spice_lite_sun_watch.wasm
// (and, for the Unix time run, a sequence built with a Unix time blob to
// spice_lite_sun_watch_unix.wasm), and build and run the unit tests. With F Prime
// as of commit 633c89d the module only loads after the change to
// SPACEWASM_MEMORY_ALIGNMENT that docs/fprime-integration.md describes.
//
// Set UNIX_TIME=1 in the environment to run the Unix time variant.

// ----------------------------------------------------------------------
// Runs the spice-lite demonstration
// sequence (sun_watch.wasm: the spice-lite library, a 13 KB geometry blob,
// and a sequence that waits for the Sun to rise at a site and then commands
// an image) inside the real WasmSequencer component.
// ----------------------------------------------------------------------

TEST_F(WasmSequencerConfigTester, SpiceLiteSunWatch) {
    // The component's default configuration, except for guest memory: the
    // module declares one 64 KiB WebAssembly page, and the default pool is 8 KiB.
    WasmSequencer::Config cfg;
    cfg.guestMemorySize = 65536;
    this->configureWith(cfg);
    this->component.loadParameters();
    this->clearHistory();

    const bool unixTime = getenv("UNIX_TIME") != nullptr;
    const TimeBase timeBase = unixTime ? TimeBase::TB_WORKSTATION_TIME : TimeBase::TB_SC_TIME;
    StagedAsset file_asset(*this, unixTime ? "spice_lite_sun_watch_unix.wasm" : "spice_lite_sun_watch.wasm");
    const Fw::String& file = file_asset.file();

    // The spacecraft clock: time base TB_SC_TIME, starting 14,400 s into the blob's window.
    // Either the spacecraft clock of the first blob (14,400 s into its window) or, for the
    // Unix time blob, the same instant as Unix seconds: 2004-06-27T04:00:00 UTC.
    const U32 clock0 = unixTime ? 1088308800u : 14400u;
    U32 clock = clock0;
    this->setTestTime(Fw::Time(timeBase, 0, clock, 0));
    this->sendCmd_RUN(0, 7001, file, BLOCK);

    U32 sleeps = 0, events = 0, dispatches = 0;
    bool commanded = false;
    for (U32 guard = 0; guard < 4000000; guard++) {
        // Every guest event the real component emitted since the last look.
        const U32 lo = static_cast<U32>(this->eventHistory_LogActivityLo->size());
        for (U32 i = 0; i < lo; i++) {
            printf("EVENT clock=%u ACTIVITY_LO %s\n", clock, this->eventHistory_LogActivityLo->at(i).msg.toChar());
            events++;
        }
        const U32 hi = static_cast<U32>(this->eventHistory_LogActivityHi->size());
        for (U32 i = 0; i < hi; i++) {
            printf("EVENT clock=%u ACTIVITY_HI %s\n", clock, this->eventHistory_LogActivityHi->at(i).msg.toChar());
            events++;
        }
        if (this->eventHistory_LogActivityLo->size() + this->eventHistory_LogActivityHi->size() != this->eventsSize) {
            this->printTextLogHistory(stdout);  // anything the component itself reported
        }
        const InterpreterState st = this->interpreterState();
        if (st == InterpreterState::RUNNING_AWAITING_RESPONSE_SLEEPING && this->messagesAvailable() == 0) {
            // The sequence asked to sleep: advance the clock past the deadline and tick the timer check.
            ASSERT_TRUE(this->hasPendingTimer());
            sleeps++;
            clock += 600;
            this->clearHistory();
            this->setTestTime(Fw::Time(timeBase, 0, clock, 0));
            this->invoke_to_checkTimers(0, 0);
            continue;
        }
        if (st == InterpreterState::RUNNING_AWAITING_RESPONSE_WAITING && this->messagesAvailable() == 0 &&
            this->fromPortHistory_cmdOut->size() > 0) {
            // The sequence dispatched its command: show the bytes and answer OK.
            const Fw::ComBuffer& out = this->fromPortHistory_cmdOut->at(0).data;
            printf("COMMAND clock=%u bytes=", clock);
            for (FwSizeType i = 0; i < out.getSize(); i++) {
                printf("%02x", out.getBuffAddr()[i]);
            }
            printf("\n");
            commanded = true;
            const U32 ctx = this->lastCmdContext();
            this->clearHistory();
            this->invoke_to_cmdResponseIn(0, 0, ctx, Fw::CmdResponse::OK);
            continue;
        }
        if (this->messagesAvailable() == 0) {
            break;
        }
        this->clearHistory();
        this->dispatchOne();
        dispatches++;
    }
    printf("DONE clock=%u sleeps=%u events=%u dispatches=%u commanded=%d controller=%d\n", clock, sleeps, events,
           dispatches, commanded ? 1 : 0, static_cast<int>(this->controllerState()));
    ASSERT_TRUE(commanded);
    ASSERT_EQ(this->controllerState(), ControllerState::READY);
    ASSERT_EQ(sleeps, 58u);
    ASSERT_EQ(clock - clock0, 49200u - 14400u);
}
