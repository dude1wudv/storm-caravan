(function () {
    'use strict';
    if (typeof window !== 'object' || typeof window.requestAnimationFrame !== 'function') {
        throw new Error('Original JSB window/frame API did not initialize');
    }
    var gl = window.__gl;
    if (!gl || typeof gl.clearColor !== 'function' || typeof gl.clear !== 'function') {
        throw new Error('The real native GL API is unavailable');
    }
    var frames = 0;
    console.log('ALLOY2581_HOST_PROBE_BOOT: native bridge only; NOT A GAME');
    function render() {
        gl.clearColor(0.08, 0.18, 0.22, 1.0);
        gl.clear(0x00004000);
        frames += 1;
        if (frames % 120 === 0) console.log('ALLOY2581_HOST_PROBE_' + frames + '_FRAMES');
        window.requestAnimationFrame(render);
    }
    window.requestAnimationFrame(render);
}());
