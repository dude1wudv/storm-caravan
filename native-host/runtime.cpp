#include "script-api.hpp"
#include "platform/CCApplication.h"
#include "base/CCScheduler.h"
#include "base/CCAutoreleasePool.h"
#include "scripting/js-bindings/event/EventDispatcher.h"
#include "scripting/js-bindings/manual/jsb_module_register.hpp"

#include <android/asset_manager.h>
#include <android/asset_manager_jni.h>
#include <android/log.h>
#include <jni.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <limits>
#include <memory>
#include <optional>
#include <stdexcept>
#include <vector>

void cocos_jni_env_init(JNIEnv* env);
extern "C" void getSDKInt(JNIEnv* env);
extern "C" void setEngineJavaVM(JavaVM*) __asm__("_ZN7cocos2d9JniHelper9setJavaVMEP7_JavaVM");

namespace {

constexpr const char* logTag = "Alloy2581Host";
AAssetManager* assets = nullptr;
int screenWidth = 0;
int screenHeight = 0;
bool ready = false;
std::chrono::steady_clock::time_point previousFrame;

#if defined(__aarch64__)
static_assert(sizeof(cocos2d::Application) == 56, "Original arm64 Application ABI mismatch");
#elif defined(__i386__)
static_assert(sizeof(cocos2d::Application) == 36, "Original x86 Application ABI mismatch");
#endif

bool packagedPath(const std::string& path) {
    if (path.empty() || path.front() == '/' || path.find('\\') != std::string::npos ||
        path.find(':') != std::string::npos || path.find('\0') != std::string::npos) return false;
    size_t start = 0;
    while (start < path.size()) {
        const size_t end = path.find('/', start);
        const std::string part = path.substr(start, end == std::string::npos ? end : end - start);
        if (part.empty() || part == "." || part == "..") return false;
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return path.back() != '/';
}

std::optional<std::vector<uint8_t>> readAsset(const std::string& path) {
    if (!assets || !packagedPath(path)) return std::nullopt;
    std::unique_ptr<AAsset, decltype(&AAsset_close)> asset(
        AAssetManager_open(assets, path.c_str(), AASSET_MODE_STREAMING), AAsset_close);
    if (!asset) return std::nullopt;
    const off64_t length = AAsset_getLength64(asset.get());
    if (length < 0 || static_cast<uint64_t>(length) > std::numeric_limits<size_t>::max())
        throw std::runtime_error("Invalid packaged asset length");
    std::vector<uint8_t> bytes(static_cast<size_t>(length));
    size_t offset = 0;
    while (offset < bytes.size()) {
        const size_t count = std::min(bytes.size() - offset, static_cast<size_t>(1024 * 1024));
        const int read = AAsset_read(asset.get(), bytes.data() + offset, count);
        if (read <= 0) throw std::runtime_error("Incomplete packaged asset read");
        offset += static_cast<size_t>(read);
    }
    return bytes;
}

bool initializeCanvas(void*) {
    const int ratio = cocos2d::Application::getInstance()->getDevicePixelRatio();
    if (ratio <= 0) return false;
    const std::string source = "window.innerWidth=" + std::to_string(screenWidth / ratio) +
        ";window.innerHeight=" + std::to_string(screenHeight / ratio) + ";";
    return alloy2581::scriptEngineEval(alloy2581::scriptEngineInstance(), source.c_str(),
        static_cast<ssize_t>(source.size()), nullptr, "alloy://canvas-initialization");
}

class LocalApplication final : public cocos2d::Application {
public:
    LocalApplication(int width, int height) : Application("Alloy2581", width, height) {}

    bool applicationDidFinishLaunching() override {
        alloy2581::ScriptFiles files;
        files.data = [](const std::string& path, const std::function<void(const uint8_t*, size_t)>& consume) {
            const auto bytes = readAsset(path);
            if (bytes) consume(bytes->data(), bytes->size());
        };
        files.text = [](const std::string& path) {
            const auto bytes = readAsset(path);
            if (!bytes) {
                __android_log_print(ANDROID_LOG_ERROR, logTag, "Required script asset is unavailable: %s", path.c_str());
                return std::string();
            }
            return std::string(bytes->begin(), bytes->end());
        };
        files.exists = [](const std::string& path) {
            if (!assets || !packagedPath(path)) return false;
            std::unique_ptr<AAsset, decltype(&AAsset_close)> asset(
                AAssetManager_open(assets, path.c_str(), AASSET_MODE_UNKNOWN), AAsset_close);
            return asset != nullptr;
        };
        files.fullPath = [](const std::string& path) {
            return packagedPath(path) ? path : std::string();
        };
        void* engine = alloy2581::scriptEngineInstance();
        alloy2581::scriptEngineSetFiles(engine, files);
        if (!jsb_register_all_modules()) return false;
        alloy2581::scriptEngineRegister(engine, initializeCanvas);
        if (!alloy2581::scriptEngineStart(engine)) return false;
        if (!alloy2581::scriptEngineRun(engine, "jsb-adapter/jsb-builtin.js", nullptr)) return false;
        ready = alloy2581::scriptEngineRun(engine, "alloy/bootstrap.js", nullptr);
        return ready;
    }

    void onPause() override {
        cocos2d::EventDispatcher::dispatchOnPauseEvent();
    }

    void onResume() override {
        cocos2d::EventDispatcher::dispatchOnResumeEvent();
    }
};

std::unique_ptr<LocalApplication> application;

void javaFailure(JNIEnv* env, const char* message) {
    if (env->ExceptionCheck()) return;
    jclass error = env->FindClass("java/lang/IllegalStateException");
    if (error) env->ThrowNew(error, message);
}

} // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
    JNIEnv* env = nullptr;
    if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_4) != JNI_OK) return JNI_ERR;
    setEngineJavaVM(vm);
    cocos_jni_env_init(env);
    getSDKInt(env);
    return JNI_VERSION_1_4;
}

extern "C" JNIEXPORT void JNICALL
Java_org_cocos2dx_lib_Cocos2dxHelper_nativeSetContext(JNIEnv* env, jclass cls, jobject context, jobject manager) {
    assets = AAssetManager_fromJava(env, manager);
    if (!assets) {
        javaFailure(env, "A real Android AssetManager is required");
        return;
    }
    void* library = dlopen("libcocos2djs.so", RTLD_NOW | RTLD_NOLOAD);
    if (!library) {
        javaFailure(env, "The verified original engine is not loaded");
        return;
    }
    using SetContext = void (*)(JNIEnv*, jclass, jobject, jobject);
    const auto setContext = reinterpret_cast<SetContext>(
        dlsym(library, "Java_org_cocos2dx_lib_Cocos2dxHelper_nativeSetContext"));
    if (setContext) setContext(env, cls, context, manager);
    else javaFailure(env, "The original Android asset bridge is unavailable");
    dlclose(library);
}

extern "C" JNIEXPORT void JNICALL
Java_org_cocos2dx_lib_Cocos2dxRenderer_nativeInit(JNIEnv* env, jclass, jint width, jint height, jstring) {
    if (application || width <= 0 || height <= 0 || !assets) {
        javaFailure(env, "Invalid or repeated independent runtime initialization");
        return;
    }
    try {
        screenWidth = width;
        screenHeight = height;
        application = std::make_unique<LocalApplication>(width, height);
        cocos2d::EventDispatcher::init();
        application->start();
        if (!ready) {
            javaFailure(env, "Independent runtime bootstrap failed; no original login was simulated");
            return;
        }
        previousFrame = std::chrono::steady_clock::now();
        __android_log_print(ANDROID_LOG_INFO, logTag, "Independent runtime bootstrap succeeded");
    } catch (const std::exception& error) {
        javaFailure(env, error.what());
    }
}

extern "C" JNIEXPORT void JNICALL
Java_org_cocos2dx_lib_Cocos2dxRenderer_nativeRender(JNIEnv* env, jclass) {
    if (!ready || !application) return;
    try {
        const auto now = std::chrono::steady_clock::now();
        const float dt = std::chrono::duration<float>(now - previousFrame).count();
        previousFrame = now;
        if (application->isDownsampleEnabled()) application->getRenderTexture()->prepare();
        application->getScheduler()->update(dt);
        cocos2d::EventDispatcher::dispatchTickEvent(dt);
        if (application->isDownsampleEnabled()) application->getRenderTexture()->draw();
        cocos2d::PoolManager::getInstance()->getCurrentPool()->clear();
    } catch (const std::exception& error) {
        ready = false;
        javaFailure(env, error.what());
    }
}

extern "C" JNIEXPORT void JNICALL
Java_org_cocos2dx_lib_Cocos2dxRenderer_nativeOnPause(JNIEnv*, jclass) {
    if (ready && application) application->onPause();
}

extern "C" JNIEXPORT void JNICALL
Java_org_cocos2dx_lib_Cocos2dxRenderer_nativeOnResume(JNIEnv*, jclass) {
    if (ready && application) {
        previousFrame = std::chrono::steady_clock::now();
        application->onResume();
    }
}

extern "C" JNIEXPORT void JNICALL
Java_org_cocos2dx_lib_Cocos2dxRenderer_nativeOnSurfaceChanged(JNIEnv* env, jclass, jint width, jint height) {
    if (!ready || !application || width <= 0 || height <= 0) return;
    screenWidth = width;
    screenHeight = height;
    application->updateViewSize(width, height);
    if (!initializeCanvas(nullptr)) javaFailure(env, "Independent canvas resize failed");
}
