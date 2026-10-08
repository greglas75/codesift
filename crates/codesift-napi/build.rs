fn main() {
    // Platform link flags for a Node addon (e.g. `-undefined dynamic_lookup` on macOS, where the
    // N-API symbols are resolved from the host process at load time).
    napi_build::setup();
}
