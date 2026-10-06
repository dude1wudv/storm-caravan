package org.stormcaravan.alloy2581;

import org.cocos2dx.lib.Cocos2dxActivity;
import org.cocos2dx.lib.Cocos2dxGLSurfaceView;
public final class AppActivity extends Cocos2dxActivity {
    @Override
    protected void onLoadNativeLibraries() {
        System.loadLibrary("alloy2581");
    }

    @Override
    public Cocos2dxGLSurfaceView onCreateView() {
        Cocos2dxGLSurfaceView view = super.onCreateView();
        // The original MaskAssembler uses the stencil buffer. The native 2581
        // context attributes request stencil=0, so physical devices can select
        // a config without a stencil attachment while the emulator happens to
        // render the same masked layouts correctly. Keep the original engine,
        // assets, masks, and scene graph; require the attachment at the window.
        view.setEGLConfigChooser(8, 8, 8, 8, 0, 8);
        return view;
    }
}
