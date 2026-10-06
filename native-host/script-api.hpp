#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>
#include <sys/types.h>

namespace alloy2581 {

// Source contract: official-source/.../v8/ScriptEngine.hpp, lines 174-207.
// The engine itself owns ScriptEngine; no replica layout or instance is created.
struct ScriptFiles {
    std::function<void(const std::string&, const std::function<void(const uint8_t*, size_t)>&)> data;
    std::function<std::string(const std::string&)> text;
    std::function<bool(const std::string&)> exists;
    std::function<std::string(const std::string&)> fullPath;
};

extern "C" void* scriptEngineInstance()
    __asm__("_ZN2se12ScriptEngine11getInstanceEv");
extern "C" void scriptEngineSetFiles(void*, const ScriptFiles&)
    __asm__("_ZN2se12ScriptEngine24setFileOperationDelegateERKNS0_21FileOperationDelegateE");
extern "C" bool scriptEngineStart(void*)
    __asm__("_ZN2se12ScriptEngine5startEv");
extern "C" void scriptEngineRegister(void*, bool (*)(void*))
    __asm__("_ZN2se12ScriptEngine19addRegisterCallbackEPFbPNS_6ObjectEE");
extern "C" bool scriptEngineRun(void*, const std::string&, void*)
    __asm__("_ZN2se12ScriptEngine9runScriptERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEEPNS_5ValueE");
#if defined(__aarch64__)
extern "C" bool scriptEngineEval(void*, const char*, ssize_t, void*, const char*)
    __asm__("_ZN2se12ScriptEngine10evalStringEPKclPNS_5ValueES2_");
#elif defined(__i386__)
extern "C" bool scriptEngineEval(void*, const char*, ssize_t, void*, const char*)
    __asm__("_ZN2se12ScriptEngine10evalStringEPKciPNS_5ValueES2_");
#else
#error "Only source-verified arm64 and x86 ScriptEngine ABIs are supported"
#endif

} // namespace alloy2581
