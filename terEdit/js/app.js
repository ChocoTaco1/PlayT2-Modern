/**
 * app.js
 * Main application: state management, UI wiring, tab logic,
 * undo/redo, greyscale preview, and mouse interaction.
 */

/* global TerEdit, BABYLON */
var TerEdit = window.TerEdit || {};

(function (TE) {
    'use strict';

    // -----------------------------------------------------------------------
    // Application state
    // -----------------------------------------------------------------------

    var state = {
        terrain    : null,    // current terrain object (heights, mat maps …)
        undoStack  : [],
        redoStack  : [],
        dirty      : false,
        activeTab  : 'view',

        // Brush
        activeTool    : 'raise',
        brushRadius   : 10,
        brushStrength : 12.5,  // metres per full stroke
        brushFalloff  : 'smooth',
        brushSymmetry : 'none', // 'none' | 'horizontal' | 'vertical' | 'central'
        targetHeight  : 100,    // m  (Set Height tool)

        // Adjust Height tool
        adjustLocked    : false,  // true while mouse is held down
        adjustBaseY     : 0,      // client Y at mousedown
        adjustSnapshot  : null,   // Float32Array snapshot of heights at mousedown
        adjustBrushGX   : 0,      // brush centre at mousedown
        adjustBrushGY   : 0,

        // Mouse
        mouseDown  : false,
        lastBrushX : -1,
        lastBrushY : -1,

        // Noise params
        noiseParams : {
            type        : 'fbm',
            scale       : 0.006,
            octaves     : 6,
            persistence : 0.5,
            lacunarity  : 2.0,
            warpScale   : 2.0,
            seed        : 42,
            minHeight   : 0,
            maxHeight   : 300,
            operation   : 'set'
        },
        noisePreviewHeights : null,

        // Display
        wireframe : false,
        showGrid  : false,
        fileName  : null,

        // Smooth All (global op)
        smoothAllStrength : 0.5,
        smoothAllPasses   : 2,
        smoothBase        : null,   // snapshot taken at start of smooth preview session

        // Remap Heights (global op)
        remapMin  : 0,
        remapMax  : 300,
        remapBase : null,    // snapshot taken when terrain loads / after Apply

        // 2D Edit tab
        edit2d : {
            mirrorAngle   : 0,      // degrees from vertical (0 = vertical line)
            mirrorEnabled : true,   // false while stamp mode is active
            mirrorAlsoFlip: false,  // also flip destination side perpendicularly
            dragActive    : false,  // dragging on the 2D canvas to rotate mirror
            // Measure tool
            measuring   : false,
            measureA    : null,   // { x, y } in grid coords
            measureB    : null,
            stamp : {
                img     : null,
                imgData : null,
                x       : 128,   // terrain grid centre X
                y       : 128,   // terrain grid centre Y
                scale   : 0.5,
                rotation: 0,     // degrees clockwise
                strength: 0.25,
                mode    : 'set'
            }
        },

        // 2D Edit (image-editor) tab — selection + clipboard ops on the heightmap
        imgEdit : {
            // selection bounding box in grid coords (integer, half-open: x0..x1-1, y0..y1-1)
            selection    : null,      // { x0, y0, x1, y1 } or null
            // selection tool mode
            selMode      : 'rect',    // 'rect' | 'ellipse' | 'lasso'
            ellipseCircle: false,     // lock ellipse to a circle
            ellipseAngle : 0,         // rotation of ellipse selection in degrees
            ellipse      : null,      // { cx, cy, rx, ry } grid coords (angle from ellipseAngle)
            mask         : null,      // Uint8Array(BLOCK*BLOCK) for lasso/ellipse, null for rect
            // drag-state during selection drawing
            selecting    : false,
            dragStart    : null,      // { x, y } grid coords of mousedown
            lassoPoints  : [],        // array of {x, y} for lasso in-progress
            // clipboard of heights
            clipboard    : null,      // { w, h, data: Float32Array, mask: Uint8Array|null, alphaMaps: Uint8Array[]|null }
            syncTextures : true,      // when true, clipboard ops also affect texture alpha layers
            fillHeight   : 100,       // metres
            delta        : 10,        // metres for raise/lower
            // Paste preview — floats on the canvas until committed
            pastePreview     : null,      // { data, origData, w, h, origW, origH, ox, oy, mask, origMask, alphaMaps, origAlphaMaps, rotation } or null
            pasteDragging    : false,     // true while dragging the paste preview
            pasteDragStart   : null,      // { mx, my, ox0, oy0 }
            pasteScaleHandle : null,      // handle object being scaled { name, hlx, hly } or null
            pasteScaleDragStart: null,    // { anchorX, anchorY, startW, startH }
            // 2D brush paint
            brush2dActive   : false,   // true when brush paint mode is enabled
            brush2dTool     : 'raise',
            brush2dRadius   : 10,
            brush2dStrength : 12.5,
            brush2dFalloff  : 'smooth',
            brush2dSymmetry : 'none',  // 'none' | 'horizontal' | 'vertical' | 'central'
            brush2dTargetHt : 100,
            brush2dPainting : false,   // pointer held down while brushing
            brush2dGX       : -1,      // current brush cursor grid position
            brush2dGY       : -1
        },

        // Texture alpha paint
        texPaint : {
            layer   : 0,
            mode    : 'paint',
            radius  : 10,
            strength: 50,
            falloff : 'smooth'
        },
        texMouseDown : false,
        texBrushGX   : -1,
        texBrushGY   : -1
    };

    // -----------------------------------------------------------------------
    // Undo / Redo helpers
    // -----------------------------------------------------------------------

    var MAX_UNDO = 50;

    function pushUndo() {
        state.undoStack.push(new Float32Array(state.terrain.heights));
        if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
        state.redoStack = [];
        state.dirty = true;
        updateUndoButtons();
    }

    function undo() {
        if (!state.undoStack.length) return;
        state.redoStack.push(new Float32Array(state.terrain.heights));
        state.terrain.heights.set(state.undoStack.pop());
        state.smoothBase = null;
        state.remapBase  = null;
        applyHeightsToAll();
        updateUndoButtons();
    }

    function redo() {
        if (!state.redoStack.length) return;
        state.undoStack.push(new Float32Array(state.terrain.heights));
        state.terrain.heights.set(state.redoStack.pop());
        state.smoothBase = null;
        state.remapBase  = null;
        applyHeightsToAll();
        updateUndoButtons();
    }

    function updateUndoButtons() {
        el('btn-undo').disabled = state.undoStack.length === 0;
        el('btn-redo').disabled = state.redoStack.length === 0;
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    function el(id) { return document.getElementById(id); }

    /**
     * After any height change: update 3D mesh, greyscale preview, status bar stats.
     * @param {object|null} dirty  optional dirty region hint { x0,x1,y0,y1 }
     */
    function applyHeightsToAll(dirty) {
        TE.updateTerrainHeights(state.terrain.heights, dirty || null);
        refreshPreviewCanvas();
        updateStats();
        if (state.activeTab === 'edit2d') draw2dCanvas();
        if (state.activeTab === 'imgedit') drawImgEditCanvas();
    }

    function updateStats() {
        var s = TE.heightStats(state.terrain.heights);
        setHTML('stat-min',   s.min.toFixed(1)   + ' m');
        setHTML('stat-max',   s.max.toFixed(1)   + ' m');
        setHTML('stat-avg',   s.avg.toFixed(1)   + ' m');
        setHTML('stat-range', s.range.toFixed(1) + ' m');
        setHTML('lbl-remap-min', 'Min (' + s.min.toFixed(0) + 'm)');
        setHTML('lbl-remap-max', 'Max (' + s.max.toFixed(0) + 'm)');
    }

    function setHTML(id, html) {
        var e = el(id); if (e) e.innerHTML = html;
    }

    function setStatus(msg) {
        var e = el('status-msg'); if (e) e.textContent = msg;
    }

    /**
     * Draw a greyscale heightmap preview onto a canvas.
     * @param {HTMLCanvasElement} canvas
     * @param {Float32Array}      heights
     */
    function drawGreyscale(canvas, heights) {
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var N   = TE.BLOCK;
        var img = ctx.createImageData(N, N);
        var lo  = heights[0], hi = heights[0];
        for (var i = 1; i < heights.length; i++) {
            if (heights[i] < lo) lo = heights[i];
            if (heights[i] > hi) hi = heights[i];
        }
        var range = (hi - lo) || 1;
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var v   = Math.round(((heights[x + y * N] - lo) / range) * 255);
                var pi  = (y * N + x) * 4;
                img.data[pi]     = v;
                img.data[pi + 1] = v;
                img.data[pi + 2] = v;
                img.data[pi + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
    }

    /**
     * Refresh the sidebar greyscale preview with a fixed-centre crosshair overlay.
     * The crosshair marks the terrain centre (the reference point when dragging to scroll).
     * When the 3D Edit (paint), View, or Noise tab is active, also draws a camera
     * position dot and look-direction arrow.
     */
    function refreshPreviewCanvas() {
        var pc = el('preview-canvas');
        if (!pc || !state.terrain) return;
        drawGreyscale(pc, state.terrain.heights);
        // Draw a fixed crosshair at the centre of the preview
        var N2   = TE.BLOCK;
        var mid  = N2 / 2;
        var ctx  = pc.getContext('2d');
        var size = 8;
        ctx.save();
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(mid - size, mid); ctx.lineTo(mid + size, mid);
        ctx.moveTo(mid, mid - size); ctx.lineTo(mid, mid + size);
        ctx.stroke();
        // Small centre dot
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.arc(mid, mid, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Camera marker: shown while 3D Edit (paint), View, or Noise tabs are active
        if (state.activeTab === 'paint' || state.activeTab === 'view' || state.activeTab === 'noise') {
            var cam = TE.getCamera();
            if (cam && cam.position) {
                var SCALE = 8; // world-units per grid cell (matches terrain3d.js)
                // Convert world XZ to preview pixel coordinates (grid cell = 1 pixel)
                var cx = cam.position.x / SCALE + N2 / 2;
                var cy = cam.position.z / SCALE + N2 / 2;

                // Clamp so the dot stays visible even if camera is outside terrain bounds
                cx = Math.max(3, Math.min(N2 - 4, cx));
                cy = Math.max(3, Math.min(N2 - 4, cy));

                // Compute look direction projected onto XZ plane
                var dx = 0, dz = 0;
                if (TE.getCamMode() === 'fly') {
                    // UniversalCamera forward direction via getForwardRay
                    var ray = cam.getForwardRay ? cam.getForwardRay(1) : null;
                    if (ray && ray.direction) {
                        dx = ray.direction.x;
                        dz = ray.direction.z;
                    }
                } else {
                    // ArcRotateCamera: direction from position toward target
                    var tgt = cam.target;
                    if (tgt) {
                        var ddx = tgt.x - cam.position.x;
                        var ddz = tgt.z - cam.position.z;
                        var len = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
                        dx = ddx / len;
                        dz = ddz / len;
                    }
                }

                var arrowLen = 14;
                ctx.save();
                // Direction arrow
                if (dx !== 0 || dz !== 0) {
                    var ex = cx + dx * arrowLen;
                    var ey = cy + dz * arrowLen;
                    ctx.strokeStyle = '#00FF00';
                    ctx.lineWidth   = 1.5;
                    ctx.beginPath();
                    ctx.moveTo(cx, cy);
                    ctx.lineTo(ex, ey);
                    ctx.stroke();
                    // Arrowhead
                    var ang = Math.atan2(dz, dx);
                    var hw  = 0.45; // half-angle in radians
                    var hl  = 5;    // arrowhead length
                    ctx.beginPath();
                    ctx.moveTo(ex, ey);
                    ctx.lineTo(ex - hl * Math.cos(ang - hw), ey - hl * Math.sin(ang - hw));
                    ctx.moveTo(ex, ey);
                    ctx.lineTo(ex - hl * Math.cos(ang + hw), ey - hl * Math.sin(ang + hw));
                    ctx.stroke();
                }
                // Camera position dot
                ctx.fillStyle = '#00FF00';
                ctx.beginPath();
                ctx.arc(cx, cy, 3, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }
    }

    /**
     * Render the 2D edit canvas: heightmap + mirror-line overlay + stamp overlay.
     * Only has effect when the edit2d tab is active.
     */
    function draw2dCanvas() {
        var canvas = el('edit2d-canvas');
        if (!canvas || !state.terrain) return;

        // Keep canvas square and as large as possible within the viewport
        var vp  = canvas.parentElement;
        var vpW = vp ? vp.clientWidth  : 800;
        var vpH = vp ? vp.clientHeight : 600;
        var side = Math.max(64, Math.min(vpW, vpH));
        canvas.style.width  = side + 'px';
        canvas.style.height = side + 'px';

        // Match canvas pixel size to display size
        if (canvas.width !== side || canvas.height !== side) {
            canvas.width  = side;
            canvas.height = side;
        }
        var cw = side, ch = side;

        var ctx    = canvas.getContext('2d');
        var N2     = TE.BLOCK;
        var heights = state.terrain.heights;

        // --- Build greyscale ImageData at BLOCK resolution ---
        var img = ctx.createImageData(N2, N2);
        var lo = heights[0], hi = heights[0];
        for (var i = 1; i < heights.length; i++) {
            if (heights[i] < lo) lo = heights[i];
            if (heights[i] > hi) hi = heights[i];
        }
        var range = (hi - lo) || 1;
        for (var iy = 0; iy < N2; iy++) {
            for (var ix = 0; ix < N2; ix++) {
                var v  = Math.round(((heights[ix + iy * N2] - lo) / range) * 255);
                var pi = (iy * N2 + ix) * 4;
                img.data[pi] = img.data[pi + 1] = img.data[pi + 2] = v;
                img.data[pi + 3] = 255;
            }
        }
        // Scale up to canvas size via offscreen canvas
        var tmp = document.createElement('canvas');
        tmp.width = N2; tmp.height = N2;
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, cw, ch);

        // --- Stamp overlay (centred at stamp position, with rotation) ---
        var st = state.edit2d.stamp;
        if (st.img) {
            var scaleX = cw / N2;
            var scaleY = ch / N2;
            var stW = st.imgData.width  * st.scale * scaleX;
            var stH = st.imgData.height * st.scale * scaleY;
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.translate(st.x * scaleX, st.y * scaleY);
            ctx.rotate((st.rotation || 0) * Math.PI / 180);
            ctx.drawImage(st.img, -stW / 2, -stH / 2, stW, stH);
            ctx.restore();
        }

        // --- Mirror-line overlay (only when mirror is enabled) ---
        if (state.edit2d.mirrorEnabled) {
        var A    = state.edit2d.mirrorAngle * Math.PI / 180;
        var sinA = Math.sin(A), cosA = Math.cos(A);
        var mcx  = cw / 2, mcy = ch / 2;
        var len  = Math.sqrt(cw * cw + ch * ch);

        ctx.save();
        ctx.strokeStyle = '#00e666';
        ctx.lineWidth   = 2;
        ctx.setLineDash([6, 3]);
        ctx.shadowColor = '#00ff66';
        ctx.shadowBlur  = 5;
        ctx.beginPath();
        // Line direction: (sinA, cosA)
        ctx.moveTo(mcx - sinA * len, mcy - cosA * len);
        ctx.lineTo(mcx + sinA * len, mcy + cosA * len);
        ctx.stroke();
        ctx.setLineDash([]);

        // Centre dot
        ctx.fillStyle = '#00e666';
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.arc(mcx, mcy, 5, 0, Math.PI * 2);
        ctx.fill();

        // Side labels: positive normal direction (-cosA, sinA)
        ctx.font      = 'bold 14px monospace';
        ctx.fillStyle = '#00e666';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var labelDist = Math.min(cw, ch) * 0.2;
        ctx.fillText('A', mcx - cosA * labelDist, mcy + sinA * labelDist);
        ctx.fillText('B', mcx + cosA * labelDist, mcy - sinA * labelDist);
        ctx.restore();
        }

        // --- Measure overlay ---
        var m  = state.edit2d;
        var scX = cw / TE.BLOCK;
        var scY = ch / TE.BLOCK;
        if (m.measureA) {
            var ax = m.measureA.x * scX, ay = m.measureA.y * scY;
            ctx.save();
            ctx.strokeStyle = '#ffcc44';
            ctx.fillStyle   = '#ffcc44';
            ctx.lineWidth   = 2;
            // Draw A marker
            ctx.beginPath();
            ctx.arc(ax, ay, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = 'bold 11px monospace';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText('A', ax + 7, ay - 3);

            if (m.measureB) {
                var bx = m.measureB.x * scX, by = m.measureB.y * scY;
                // Line
                ctx.beginPath();
                ctx.setLineDash([5, 3]);
                ctx.moveTo(ax, ay);
                ctx.lineTo(bx, by);
                ctx.stroke();
                ctx.setLineDash([]);
                // B marker
                ctx.beginPath();
                ctx.arc(bx, by, 5, 0, Math.PI * 2);
                ctx.fill();
                ctx.textAlign = 'left';
                ctx.fillText('B', bx + 7, by - 3);
                // Distance label at midpoint
                var mx2 = (ax + bx) / 2, my2 = (ay + by) / 2;
                var dx2 = (m.measureB.x - m.measureA.x) * TE.SCALE;
                var dy2 = (m.measureB.y - m.measureA.y) * TE.SCALE;
                var dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 12px monospace';
                ctx.strokeStyle = '#333';
                ctx.lineWidth = 3;
                ctx.strokeText(dist2.toFixed(0) + 'm', mx2, my2 - 10);
                ctx.fillText(dist2.toFixed(0) + 'm', mx2, my2 - 10);
            }
            ctx.restore();
        }
    }

    /**
     * Draw the current alpha-paint layer as a fullscreen greyscale image on edit2d-canvas.
     * Only effective when the texture tab is active.
     * Also draws a green/red brush circle at the current brush position.
     */
    function drawTexCanvas() {
        var canvas = el('edit2d-canvas');
        if (!canvas || !state.terrain) return;

        // Size canvas to fill the viewport (same logic as draw2dCanvas)
        var vp   = canvas.parentElement;
        var vpW  = vp ? vp.clientWidth  : 800;
        var vpH  = vp ? vp.clientHeight : 600;
        var side = Math.max(64, Math.min(vpW, vpH));
        canvas.style.width  = side + 'px';
        canvas.style.height = side + 'px';
        if (canvas.width !== side || canvas.height !== side) {
            canvas.width  = side;
            canvas.height = side;
        }
        var cw = side, ch = side;
        var ctx = canvas.getContext('2d');
        var N2  = TE.BLOCK;

        var k        = state.texPaint ? state.texPaint.layer : 0;
        var alphaMaps = state.terrain.materialAlphaMaps || [];
        var alphaMap  = alphaMaps[k] || null;

        // Build greyscale ImageData for the alpha layer
        var img = ctx.createImageData(N2, N2);
        for (var i = 0; i < N2 * N2; i++) {
            var v  = alphaMap ? alphaMap[i] : 0;
            img.data[i * 4]     = v;
            img.data[i * 4 + 1] = v;
            img.data[i * 4 + 2] = v;
            img.data[i * 4 + 3] = 255;
        }
        var tmp = document.createElement('canvas');
        tmp.width = N2; tmp.height = N2;
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, cw, ch);

        // Brush circle overlay
        if (state.texBrushGX >= 0 && state.texBrushGY >= 0) {
            var bx = (state.texBrushGX / N2) * cw;
            var by = (state.texBrushGY / N2) * ch;
            var br = Math.max(1, (state.texPaint.radius / N2) * cw);
            ctx.save();
            ctx.strokeStyle = (state.texPaint && state.texPaint.mode === 'erase') ? '#ff4444' : '#44ffaa';
            ctx.lineWidth   = 2;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.arc(bx, by, br, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    // -----------------------------------------------------------------------
    // 2D Edit (image-editor) tab — selection + clipboard helpers
    // -----------------------------------------------------------------------

    /**
     * Render the image-editor 2D canvas: greyscale heightmap + selection rectangle.
     * Only has effect when the imgedit tab is active.
     */
    function drawImgEditCanvas() {
        var canvas = el('edit2d-canvas');
        if (!canvas || !state.terrain) return;

        // Size canvas square (same convention as draw2dCanvas)
        var vp   = canvas.parentElement;
        var vpW  = vp ? vp.clientWidth  : 800;
        var vpH  = vp ? vp.clientHeight : 600;
        var side = Math.max(64, Math.min(vpW, vpH));
        canvas.style.width  = side + 'px';
        canvas.style.height = side + 'px';
        if (canvas.width !== side || canvas.height !== side) {
            canvas.width  = side;
            canvas.height = side;
        }
        var cw = side, ch = side;
        var ctx = canvas.getContext('2d');
        var N2  = TE.BLOCK;
        var heights = state.terrain.heights;

        // ── Greyscale heightmap (auto-normalised, nearest-neighbour upscale) ──
        var img  = ctx.createImageData(N2, N2);
        var hmin = heights[0], hmax = heights[0];
        for (var i = 1; i < heights.length; i++) {
            if (heights[i] < hmin) hmin = heights[i];
            if (heights[i] > hmax) hmax = heights[i];
        }
        var hrange = (hmax - hmin) || 1;
        for (var iy = 0; iy < N2; iy++) {
            for (var ix = 0; ix < N2; ix++) {
                var pv  = Math.round(((heights[ix + iy * N2] - hmin) / hrange) * 255);
                var pi  = (iy * N2 + ix) * 4;
                img.data[pi] = img.data[pi + 1] = img.data[pi + 2] = pv;
                img.data[pi + 3] = 255;
            }
        }
        var htmpC = document.createElement('canvas');
        htmpC.width = N2; htmpC.height = N2;
        htmpC.getContext('2d').putImageData(img, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(htmpC, 0, 0, cw, ch);

        var scX = cw / N2;
        var scY = ch / N2;
        var ie  = state.imgEdit;

        // ── Stamp overlay (stamp can be used from imgedit tab) ──────────────
        var st = state.edit2d.stamp;
        if (st.img) {
            var stW = st.imgData.width  * st.scale * scX;
            var stH = st.imgData.height * st.scale * scY;
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.translate(st.x * scX, st.y * scY);
            ctx.rotate((st.rotation || 0) * Math.PI / 180);
            ctx.drawImage(st.img, -stW / 2, -stH / 2, stW, stH);
            ctx.restore();
            return; // don't draw selection overlay while stamp is active
        }

        // ── Paste preview overlay ────────────────────────────────────────────
        var pp = ie.pastePreview;
        if (pp) {
            // Render clipboard as greyscale, masking out non-selected pixels
            var ppC = document.createElement('canvas');
            ppC.width = pp.w; ppC.height = pp.h;
            var ppCtx = ppC.getContext('2d');
            var ppImg = ppCtx.createImageData(pp.w, pp.h);
            var ppLo = pp.data[0], ppHi = pp.data[0];
            for (var k = 1; k < pp.data.length; k++) {
                if (pp.data[k] < ppLo) ppLo = pp.data[k];
                if (pp.data[k] > ppHi) ppHi = pp.data[k];
            }
            var ppRng = (ppHi - ppLo) || 1;
            for (var k = 0; k < pp.data.length; k++) {
                var pv2 = Math.round(((pp.data[k] - ppLo) / ppRng) * 255);
                ppImg.data[k * 4]     = pv2;
                ppImg.data[k * 4 + 1] = pv2;
                ppImg.data[k * 4 + 2] = pv2;
                // Masked-out pixels are fully transparent so only the shape shows
                ppImg.data[k * 4 + 3] = (!pp.mask || pp.mask[k]) ? 200 : 0;
            }
            ppCtx.putImageData(ppImg, 0, 0);
            var ppCenterX = (pp.ox + pp.w / 2) * scX;
            var ppCenterY = (pp.oy + pp.h / 2) * scY;
            var ppw = pp.w * scX, pph = pp.h * scY;
            var ppAngle = (pp.rotation || 0) * Math.PI / 180;
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.translate(ppCenterX, ppCenterY);
            ctx.rotate(ppAngle);
            ctx.drawImage(ppC, -ppw / 2, -pph / 2, ppw, pph);
            ctx.strokeStyle = '#ffcc44';
            ctx.lineWidth   = 2;
            ctx.setLineDash([6, 3]);
            ctx.strokeRect(-ppw / 2 + 1, -pph / 2 + 1, ppw - 2, pph - 2);
            ctx.setLineDash([]);
            // Show rotation angle when non-zero
            if (pp.rotation) {
                ctx.fillStyle = '#ffcc44';
                ctx.font      = 'bold 11px monospace';
                ctx.fillText((pp.rotation || 0) + '\xb0', -ppw / 2 + 4, -pph / 2 - 3);
            }
            ctx.restore();
            // Draw 8 scale handles in un-rotated screen space
            var handles = getPasteHandles(pp, cw, ch, TE.BLOCK);
            var hs = 5; // half-size in pixels
            handles.forEach(function (h) {
                ctx.fillStyle   = '#ffcc44';
                ctx.strokeStyle = '#222';
                ctx.lineWidth   = 1.5;
                ctx.fillRect  (Math.round(h.sx - hs), Math.round(h.sy - hs), hs * 2, hs * 2);
                ctx.strokeRect(Math.round(h.sx - hs) + 0.5, Math.round(h.sy - hs) + 0.5, hs * 2, hs * 2);
            });
            return; // don't draw selection overlay over paste preview
        }

        // ── Selection dim + border ───────────────────────────────────────────
        var sel = ie.selection;
        if (sel) {
            // Dim everything outside the selection using a composite approach
            var dimC  = document.createElement('canvas');
            dimC.width = cw; dimC.height = ch;
            var dimCx = dimC.getContext('2d');
            dimCx.fillStyle = 'rgba(0,0,0,0.35)';
            dimCx.fillRect(0, 0, cw, ch);
            dimCx.globalCompositeOperation = 'destination-out';

            if (ie.selMode === 'lasso' && ie.lassoPoints.length >= 3 && !ie.selecting) {
                var lpts = ie.lassoPoints;
                dimCx.beginPath();
                dimCx.moveTo(lpts[0].x * scX, lpts[0].y * scY);
                for (var li = 1; li < lpts.length; li++) {
                    dimCx.lineTo(lpts[li].x * scX, lpts[li].y * scY);
                }
                dimCx.closePath();
                dimCx.fill();
            } else if (ie.selMode === 'ellipse' && ie.ellipse && !ie.selecting) {
                var ell2 = ie.ellipse;
                var ear  = ie.ellipseAngle * Math.PI / 180;
                dimCx.beginPath();
                dimCx.ellipse(ell2.cx * scX, ell2.cy * scY,
                              ell2.rx * scX, ell2.ry * scY, ear, 0, Math.PI * 2);
                dimCx.fill();
            } else {
                // Rect (or in-progress non-rect)
                dimCx.fillRect(sel.x0 * scX, sel.y0 * scY,
                               (sel.x1 - sel.x0) * scX, (sel.y1 - sel.y0) * scY);
            }

            ctx.drawImage(dimC, 0, 0);

            // Selection border
            ctx.save();
            ctx.strokeStyle = '#ffcc44';
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([5, 3]);

            if (ie.selMode === 'lasso' && ie.lassoPoints.length >= 2) {
                var lpts2 = ie.lassoPoints;
                ctx.beginPath();
                ctx.moveTo(lpts2[0].x * scX, lpts2[0].y * scY);
                for (var li2 = 1; li2 < lpts2.length; li2++) {
                    ctx.lineTo(lpts2[li2].x * scX, lpts2[li2].y * scY);
                }
                if (!ie.selecting) ctx.closePath();
                ctx.stroke();
            } else if (ie.selMode === 'ellipse' && ie.ellipse) {
                var ell3 = ie.ellipse;
                var ear2 = ie.ellipseAngle * Math.PI / 180;
                ctx.beginPath();
                ctx.ellipse(ell3.cx * scX, ell3.cy * scY,
                            ell3.rx * scX, ell3.ry * scY, ear2, 0, Math.PI * 2);
                ctx.stroke();
            } else {
                ctx.strokeRect(sel.x0 * scX + 0.5, sel.y0 * scY + 0.5,
                               (sel.x1 - sel.x0) * scX - 1,
                               (sel.y1 - sel.y0) * scY - 1);
            }

            ctx.setLineDash([]);
            ctx.restore();
        }

        // ── Lasso: draw in-progress path while still dragging ─────────────────
        if (ie.selMode === 'lasso' && ie.selecting && ie.lassoPoints.length >= 1) {
            var lpts3 = ie.lassoPoints;
            ctx.save();
            ctx.strokeStyle = '#ff88ff';
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(lpts3[0].x * scX, lpts3[0].y * scY);
            for (var li3 = 1; li3 < lpts3.length; li3++) {
                ctx.lineTo(lpts3[li3].x * scX, lpts3[li3].y * scY);
            }
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }

        // ── Brush cursor circle (when brush mode is active) ────────────────
        if (ie.brush2dActive && ie.brush2dGX >= 0) {
            var bcx = ie.brush2dGX * scX;
            var bcy = ie.brush2dGY * scY;
            var bcr = ie.brush2dRadius * scX; // radius in pixels (scX == scY when canvas is square)
            ctx.save();
            ctx.strokeStyle = '#4a9eff';
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.arc(bcx, bcy, Math.max(1, bcr), 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    // ── Mask / selection helpers ─────────────────────────────────────────────

    /**
     * Build a normalised selection rectangle in grid coords from two corner points.
     * Clamps to terrain bounds and ensures non-zero area.
     * Returns null for an empty rect.
     */
    function normalizeSelection(ax, ay, bx, by) {
        var N = TE.BLOCK;
        var x0 = Math.max(0, Math.min(N, Math.floor(Math.min(ax, bx))));
        var y0 = Math.max(0, Math.min(N, Math.floor(Math.min(ay, by))));
        var x1 = Math.max(0, Math.min(N, Math.ceil (Math.max(ax, bx))));
        var y1 = Math.max(0, Math.min(N, Math.ceil (Math.max(ay, by))));
        if (x1 <= x0 || y1 <= y0) return null;
        return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    /** Compute the axis-aligned bounding box of a rotated ellipse, as a normalised selection. */
    function ellipseBBox(ell, angleDeg) {
        var a  = (angleDeg || 0) * Math.PI / 180;
        var ux = ell.rx * Math.abs(Math.cos(a));
        var uy = ell.rx * Math.abs(Math.sin(a));
        var vx = ell.ry * Math.abs(Math.sin(a));
        var vy = ell.ry * Math.abs(Math.cos(a));
        return normalizeSelection(ell.cx - (ux + vx), ell.cy - (uy + vy),
                                  ell.cx + (ux + vx), ell.cy + (uy + vy));
    }

    /** Compute bounding box of a lasso polygon. */
    function lassoBBox(pts) {
        var N = TE.BLOCK;
        var minX = N, maxX = 0, minY = N, maxY = 0;
        for (var i = 0; i < pts.length; i++) {
            if (pts[i].x < minX) minX = pts[i].x;
            if (pts[i].x > maxX) maxX = pts[i].x;
            if (pts[i].y < minY) minY = pts[i].y;
            if (pts[i].y > maxY) maxY = pts[i].y;
        }
        return normalizeSelection(minX, minY, maxX, maxY);
    }

    /** Per-pixel mask from a polygon (scanline fill). */
    function computeLassoMask(pts) {
        var N   = TE.BLOCK;
        var msk = new Uint8Array(N * N);
        if (pts.length < 3) return msk;
        var n = pts.length;
        for (var y = 0; y < N; y++) {
            var xs = [];
            for (var i = 0, j = n - 1; i < n; j = i++) {
                var xi = pts[i].x, yi = pts[i].y;
                var xj = pts[j].x, yj = pts[j].y;
                if ((yi <= y && y < yj) || (yj <= y && y < yi)) {
                    xs.push(xi + (y - yi) / (yj - yi) * (xj - xi));
                }
            }
            xs.sort(function (a, b) { return a - b; });
            for (var k = 0; k + 1 < xs.length; k += 2) {
                var x0 = Math.max(0, Math.ceil(xs[k]));
                var x1 = Math.min(N - 1, Math.floor(xs[k + 1]));
                for (var x = x0; x <= x1; x++) msk[x + y * N] = 1;
            }
        }
        return msk;
    }

    /** Per-pixel mask from a (possibly rotated) ellipse. */
    function computeEllipseMask(ell, angleDeg) {
        var N    = TE.BLOCK;
        var msk  = new Uint8Array(N * N);
        if (!ell || ell.rx < 0.5 || ell.ry < 0.5) return msk;
        var a    = -(angleDeg || 0) * Math.PI / 180;
        var cosA = Math.cos(a), sinA = Math.sin(a);
        var rx2  = ell.rx * ell.rx, ry2 = ell.ry * ell.ry;
        var bbox = ellipseBBox(ell, angleDeg || 0);
        if (!bbox) return msk;
        for (var y = bbox.y0; y < bbox.y1; y++) {
            for (var x = bbox.x0; x < bbox.x1; x++) {
                var dx = x - ell.cx, dy = y - ell.cy;
                var ex = cosA * dx - sinA * dy;
                var ey = sinA * dx + cosA * dy;
                if (ex * ex / rx2 + ey * ey / ry2 <= 1) msk[x + y * N] = 1;
            }
        }
        return msk;
    }

    /** Copy the current selection's bounding-box heights (and mask) to clipboard. */
    function copySelectionToClipboard() {
        var ie  = state.imgEdit;
        var sel = ie.selection;
        if (!sel || !state.terrain) return;
        var w = sel.x1 - sel.x0, h = sel.y1 - sel.y0;
        var data = new Float32Array(w * h);
        var N = TE.BLOCK;
        // Build bbox-relative copy of the mask (if any)
        var localMask = null;
        if (ie.mask) {
            localMask = new Uint8Array(w * h);
            for (var ly = 0; ly < h; ly++) {
                for (var lx = 0; lx < w; lx++) {
                    localMask[lx + ly * w] = ie.mask[(sel.x0 + lx) + (sel.y0 + ly) * N];
                }
            }
        }
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                data[x + y * w] = state.terrain.heights[(sel.x0 + x) + (sel.y0 + y) * N];
            }
        }
        ie.clipboard = { w: w, h: h, data: data, mask: localMask, alphaMaps: null };

        // Optionally copy texture alpha layers
        if (ie.syncTextures && state.terrain.materialAlphaMaps) {
            var alphaMaps = state.terrain.materialAlphaMaps;
            var clipAlpha = [];
            for (var k = 0; k < alphaMaps.length; k++) {
                if (alphaMaps[k]) {
                    var aSlice = new Uint8Array(w * h);
                    for (var ay = 0; ay < h; ay++) {
                        for (var ax = 0; ax < w; ax++) {
                            aSlice[ax + ay * w] = alphaMaps[k][(sel.x0 + ax) + (sel.y0 + ay) * N];
                        }
                    }
                    clipAlpha[k] = aSlice;
                } else {
                    clipAlpha[k] = null;
                }
            }
            ie.clipboard.alphaMaps = clipAlpha;
        }
        saveClipboardToStorage(ie.clipboard);
    }

    /**
     * Persist the clipboard to localStorage so it can be read by other open tabs.
     * @param {object|null} clip  ie.clipboard object, or null to clear.
     */
    function saveClipboardToStorage(clip) {
        if (!clip) { try { localStorage.removeItem('terEdit_clipboard'); } catch (e) {} return; }
        try {
            var obj = {
                w         : clip.w,
                h         : clip.h,
                data      : Array.from(clip.data),
                mask      : clip.mask ? Array.from(clip.mask) : null,
                alphaMaps : clip.alphaMaps
                    ? clip.alphaMaps.map(function (a) { return a ? Array.from(a) : null; })
                    : null
            };
            localStorage.setItem('terEdit_clipboard', JSON.stringify(obj));
        } catch (e) { /* quota exceeded or storage unavailable — silently ignore */ }
    }

    /**
     * Restore the clipboard from localStorage into ie.clipboard.
     * Called before every paste so content copied in another tab is available.
     * No-ops silently if localStorage is unavailable or the stored value is invalid.
     */
    function loadClipboardFromStorage() {
        try {
            var raw = localStorage.getItem('terEdit_clipboard');
            if (!raw) return;
            var obj = JSON.parse(raw);
            if (!obj || typeof obj.w !== 'number' || typeof obj.h !== 'number' || !obj.data) return;
            state.imgEdit.clipboard = {
                w         : obj.w,
                h         : obj.h,
                data      : new Float32Array(obj.data),
                mask      : obj.mask ? new Uint8Array(obj.mask) : null,
                alphaMaps : obj.alphaMaps
                    ? obj.alphaMaps.map(function (a) { return a ? new Uint8Array(a) : null; })
                    : null
            };
        } catch (e) { /* parse error or storage unavailable — silently ignore */ }
    }

    /**
     * Write paste-preview data into the terrain, applying the current rotation offset.
     * Iterates every world cell within the diagonal radius of the paste bounding box
     * and back-projects via inverse rotation to find the source pixel.
     * @param {object} pp  pastePreview object { data, w, h, ox, oy, mask, rotation, alphaMaps }
     * @param {number} N   terrain grid size (TE.BLOCK)
     */
    function writePasteData(pp, N) {
        var angle = -(pp.rotation || 0) * Math.PI / 180; // inverse rotation for sampling
        var cosA  = Math.cos(angle), sinA = Math.sin(angle);
        var cwx   = pp.ox + pp.w / 2;  // world-space center of the paste box
        var cwy   = pp.oy + pp.h / 2;
        var csx   = pp.w / 2;           // source-space center
        var csy   = pp.h / 2;
        var halfDiag = Math.ceil(Math.sqrt(pp.w * pp.w + pp.h * pp.h) / 2) + 1;
        var txMin = Math.max(0,     Math.floor(cwx - halfDiag));
        var txMax = Math.min(N - 1, Math.ceil( cwx + halfDiag));
        var tyMin = Math.max(0,     Math.floor(cwy - halfDiag));
        var tyMax = Math.min(N - 1, Math.ceil( cwy + halfDiag));

        // Ensure alpha maps exist when we'll write to them
        var writeAlpha = state.imgEdit.syncTextures && pp.alphaMaps && state.terrain.materialAlphaMaps;
        if (writeAlpha && !state.terrain.materialAlphaMaps) {
            state.terrain.materialAlphaMaps = new Array(TE.MAT_GROUPS).fill(null);
        }

        for (var ty = tyMin; ty <= tyMax; ty++) {
            for (var tx = txMin; tx <= txMax; tx++) {
                var relX = tx - cwx, relY = ty - cwy;
                var sx   = Math.round(cosA * relX - sinA * relY + csx);
                var sy   = Math.round(sinA * relX + cosA * relY + csy);
                if (sx < 0 || sx >= pp.w || sy < 0 || sy >= pp.h) continue;
                if (pp.mask && !pp.mask[sx + sy * pp.w]) continue;
                state.terrain.heights[tx + ty * N] = pp.data[sx + sy * pp.w];

                // Also write texture alpha layers if syncing
                if (writeAlpha) {
                    for (var k = 0; k < pp.alphaMaps.length; k++) {
                        if (!pp.alphaMaps[k]) continue;
                        if (!state.terrain.materialAlphaMaps[k]) {
                            state.terrain.materialAlphaMaps[k] = new Uint8Array(N * N);
                        }
                        state.terrain.materialAlphaMaps[k][tx + ty * N] = pp.alphaMaps[k][sx + sy * pp.w];
                    }
                }
            }
        }
    }

    /** Stamp the floating paste preview onto the terrain without clearing the preview. */
    function stampPastePreview() {
        var ie = state.imgEdit;
        var pp = ie.pastePreview;
        if (!pp || !state.terrain) return;
        var N = TE.BLOCK;
        pushUndo();
        writePasteData(pp, N);
        applyHeightsToAll();
        setStatus('Stamped at (' + Math.round(pp.ox) + ',' + Math.round(pp.oy) + ')\u2002rot: ' + (pp.rotation || 0) + '\xb0 \u2014 move & middle-click to stamp again, right-click to cancel.');
    }

    /** Commit the floating paste preview to the terrain. */
    function commitPastePreview() {
        var ie = state.imgEdit;
        var pp = ie.pastePreview;
        if (!pp || !state.terrain) return;
        var N = TE.BLOCK;
        pushUndo();
        writePasteData(pp, N);
        ie.selection = {
            x0: Math.max(0, Math.floor(pp.ox)),
            y0: Math.max(0, Math.floor(pp.oy)),
            x1: Math.min(N, Math.ceil(pp.ox + pp.w)),
            y1: Math.min(N, Math.ceil(pp.oy + pp.h))
        };
        ie.pastePreview      = null;
        ie.pasteDragging     = false;
        ie.pasteDragStart    = null;
        ie.pasteScaleHandle  = null;
        ie.pasteScaleDragStart = null;
        var cv2d = el('edit2d-canvas');
        if (cv2d) cv2d.style.cursor = 'crosshair';
        applyHeightsToAll();
        imgEditUpdateInfo();
        setStatus('Paste committed at (' + pp.ox + ',' + pp.oy + ').');
    }

    // ── Paste-preview scale handle helpers ──────────────────────────────────

    /**
     * Handle descriptors: name, normalised local-from-centre coords (hlx, hly each ±1 or 0).
     * The normalised coords are multiplied by w/2 or h/2 to get grid offsets.
     */
    var PASTE_HANDLE_DEFS = [
        { name: 'tl', hlx: -1, hly: -1 },
        { name: 't',  hlx:  0, hly: -1 },
        { name: 'tr', hlx:  1, hly: -1 },
        { name: 'r',  hlx:  1, hly:  0 },
        { name: 'br', hlx:  1, hly:  1 },
        { name: 'b',  hlx:  0, hly:  1 },
        { name: 'bl', hlx: -1, hly:  1 },
        { name: 'l',  hlx: -1, hly:  0 }
    ];

    /** Return array of {name, hlx, hly, sx, sy} in screen pixels for the 8 handles. */
    function getPasteHandles(pp, cw, ch, N) {
        var angle = (pp.rotation || 0) * Math.PI / 180;
        var cosA  = Math.cos(angle), sinA = Math.sin(angle);
        var sc    = cw / N;   // cw === ch (canvas is square)
        var cx    = (pp.ox + pp.w / 2) * sc;
        var cy    = (pp.oy + pp.h / 2) * sc;
        var hw    = pp.w / 2 * sc;
        var hh    = pp.h / 2 * sc;
        return PASTE_HANDLE_DEFS.map(function (d) {
            var lx = d.hlx * hw, ly = d.hly * hh;
            return {
                name: d.name, hlx: d.hlx, hly: d.hly,
                sx: cx + lx * cosA - ly * sinA,
                sy: cy + lx * sinA + ly * cosA
            };
        });
    }

    /** Return handle descriptor if screen point (px, py) hits a handle, else null. */
    function hitPasteHandle(px, py, pp, cw, ch, N) {
        var handles = getPasteHandles(pp, cw, ch, N);
        var r2 = 7 * 7;
        for (var i = 0; i < handles.length; i++) {
            var h = handles[i];
            var dx = px - h.sx, dy = py - h.sy;
            if (dx * dx + dy * dy <= r2) return h;
        }
        return null;
    }

    /** Bilinear resample Float32Array from srcW×srcH to dstW×dstH. */
    function resampleFloat32(src, srcW, srcH, dstW, dstH) {
        var dst = new Float32Array(dstW * dstH);
        for (var dy = 0; dy < dstH; dy++) {
            for (var dx = 0; dx < dstW; dx++) {
                var sx  = (dx + 0.5) * srcW / dstW - 0.5;
                var sy  = (dy + 0.5) * srcH / dstH - 0.5;
                var sx0 = Math.max(0, Math.floor(sx)), sx1 = Math.min(srcW - 1, sx0 + 1);
                var sy0 = Math.max(0, Math.floor(sy)), sy1 = Math.min(srcH - 1, sy0 + 1);
                var tx  = sx - sx0, ty = sy - sy0;
                dst[dx + dy * dstW] =
                    (1 - tx) * (1 - ty) * src[sx0 + sy0 * srcW] +
                    tx       * (1 - ty) * src[sx1 + sy0 * srcW] +
                    (1 - tx) * ty       * src[sx0 + sy1 * srcW] +
                    tx       * ty       * src[sx1 + sy1 * srcW];
            }
        }
        return dst;
    }

    /** Bilinear resample Uint8Array from srcW×srcH to dstW×dstH. */
    function resampleUint8(src, srcW, srcH, dstW, dstH) {
        var dst = new Uint8Array(dstW * dstH);
        for (var dy = 0; dy < dstH; dy++) {
            for (var dx = 0; dx < dstW; dx++) {
                var sx  = (dx + 0.5) * srcW / dstW - 0.5;
                var sy  = (dy + 0.5) * srcH / dstH - 0.5;
                var sx0 = Math.max(0, Math.floor(sx)), sx1 = Math.min(srcW - 1, sx0 + 1);
                var sy0 = Math.max(0, Math.floor(sy)), sy1 = Math.min(srcH - 1, sy0 + 1);
                var tx  = sx - sx0, ty = sy - sy0;
                dst[dx + dy * dstW] = Math.round(
                    (1 - tx) * (1 - ty) * src[sx0 + sy0 * srcW] +
                    tx       * (1 - ty) * src[sx1 + sy0 * srcW] +
                    (1 - tx) * ty       * src[sx0 + sy1 * srcW] +
                    tx       * ty       * src[sx1 + sy1 * srcW]);
            }
        }
        return dst;
    }

    /**
     * Resize the paste preview to newW × newH and reposition to (newOX, newOY).
     * Resamples data, mask, and alphaMaps from the originals stored in pp.
     */
    function applyPasteScale(pp, newW, newH, newOX, newOY) {
        newW = Math.max(1, Math.round(newW));
        newH = Math.max(1, Math.round(newH));
        pp.ox = Math.round(newOX);
        pp.oy = Math.round(newOY);
        if (newW === pp.w && newH === pp.h) return;
        pp.w = newW;
        pp.h = newH;
        // Resample from originals
        pp.data = resampleFloat32(pp.origData, pp.origW, pp.origH, newW, newH);
        pp.mask = pp.origMask ? resampleUint8(pp.origMask, pp.origW, pp.origH, newW, newH) : null;
        if (pp.origAlphaMaps) {
            pp.alphaMaps = pp.origAlphaMaps.map(function (a) {
                return a ? resampleUint8(a, pp.origW, pp.origH, newW, newH) : null;
            });
        }
    }

    /** CSS cursor names indexed by handle name. */
    var HANDLE_CURSORS = {
        tl: 'nwse-resize', t: 'ns-resize',  tr: 'nesw-resize',
        r:  'ew-resize',  br: 'nwse-resize', b:  'ns-resize',
        bl: 'nesw-resize', l: 'ew-resize'
    };


    function imgEditUpdateInfo() {
        var ie  = state.imgEdit;
        var sel = ie.selection;
        if (sel) {
            var w = sel.x1 - sel.x0, h = sel.y1 - sel.y0;
            var modeLabel = ie.selMode === 'ellipse' ? 'Ellipse'
                          : ie.selMode === 'lasso'   ? 'Lasso' : 'Rect';
            setHTML('imgedit-sel-info',
                modeLabel + ': ' + w + '\xd7' + h + ' at (' + sel.x0 + ',' + sel.y0 + ')');
            // Sync X/Y/W/H inputs
            var xi = el('imgedit-sel-x'), yi = el('imgedit-sel-y');
            var wi = el('imgedit-sel-w'), hi = el('imgedit-sel-h');
            if (xi) xi.value = sel.x0;
            if (yi) yi.value = sel.y0;
            if (wi) wi.value = w;
            if (hi) hi.value = h;
        } else {
            setHTML('imgedit-sel-info', 'No selection');
        }
        var clip = ie.clipboard;
        setHTML('imgedit-clip-info',
            clip ? 'Clipboard: ' + clip.w + '\xd7' + clip.h + ' cells' : 'Clipboard: empty');
        // Show/hide paste commit/cancel row
        var pa = el('imgedit-paste-actions');
        if (pa) pa.style.display = ie.pastePreview ? '' : 'none';
    }

    /** Iterate every cell index inside the current selection (mask-aware). */
    function forEachSelected(fn) {
        var ie  = state.imgEdit;
        var sel = ie.selection;
        if (!sel) return;
        var N   = TE.BLOCK;
        var msk = ie.mask;
        for (var y = sel.y0; y < sel.y1; y++) {
            for (var x = sel.x0; x < sel.x1; x++) {
                if (!msk || msk[x + y * N]) fn(x + y * N, x, y);
            }
        }
    }

    /** Invert the current selection (select what is NOT currently selected). */
    function invertSelection() {
        var ie = state.imgEdit;
        var N  = TE.BLOCK;
        // Build a new full-map mask that is the complement of the existing selection
        var newMask = new Uint8Array(N * N);
        // Start with everything selected
        for (var i = 0; i < newMask.length; i++) newMask[i] = 1;
        // Clear cells that ARE currently selected
        if (ie.selection) {
            var sel = ie.selection;
            var msk = ie.mask;
            for (var y = sel.y0; y < sel.y1; y++) {
                for (var x = sel.x0; x < sel.x1; x++) {
                    if (!msk || msk[x + y * N]) {
                        newMask[x + y * N] = 0;
                    }
                }
            }
        }
        // Check if all cells are now set (no previous selection → invert = select all)
        var allSet = true;
        for (var j = 0; j < newMask.length; j++) {
            if (!newMask[j]) { allSet = false; break; }
        }
        if (allSet) {
            ie.selection   = { x0: 0, y0: 0, x1: N, y1: N };
            ie.mask        = null;
            ie.selMode     = 'rect';
        } else {
            ie.selection   = { x0: 0, y0: 0, x1: N, y1: N };
            ie.mask        = newMask;
            ie.selMode     = 'lasso'; // lasso mode draws the per-pixel dim correctly
        }
        ie.ellipse     = null;
        ie.lassoPoints = [];
    }

    /**
     * Apply the 2D brush at grid position (gx, gy) using the imgEdit brush2d settings,
     * plus any symmetrical mirror positions from ie.brush2dSymmetry.
     * Also calls drawImgEditCanvas so the updated greyscale and brush cursor are visible.
     */
    function applyBrush2d(gx, gy) {
        var ie  = state.imgEdit;
        var h   = state.terrain.heights;
        var r   = ie.brush2dRadius;
        var s   = ie.brush2dStrength;
        var fo  = ie.brush2dFalloff;
        var N2  = TE.BLOCK;
        var sym = ie.brush2dSymmetry;

        // Build list of positions: primary + symmetric mirrors
        var positions = [{ x: gx, y: gy }];
        if (sym === 'horizontal' || sym === 'central') {
            positions.push({ x: N2 - 1 - gx, y: gy });
        }
        if (sym === 'vertical' || sym === 'central') {
            positions.push({ x: gx, y: N2 - 1 - gy });
        }
        if (sym === 'central') {
            positions.push({ x: N2 - 1 - gx, y: N2 - 1 - gy });
        }

        for (var pi = 0; pi < positions.length; pi++) {
            var cx = positions[pi].x, cy = positions[pi].y;
            switch (ie.brush2dTool) {
                case 'raise':     TE.brushRaise(h, cx, cy, r, s, fo);                            break;
                case 'lower':     TE.brushLower(h, cx, cy, r, s, fo);                            break;
                case 'flatten':   TE.brushFlatten(h, cx, cy, r, s, fo);                          break;
                case 'smooth':    TE.brushSmooth(h, cx, cy, r, s, fo);                           break;
                case 'setHeight': TE.brushSetHeight(h, cx, cy, r, s, fo, ie.brush2dTargetHt);    break;
                case 'slope':     TE.brushSlope(h, cx, cy, r, s, fo);                            break;
            }
        }
        drawImgEditCanvas();
    }

    /**
     * Draw a noise preview (without committing it).
     */
    function drawNoisePreview() {
        var params  = Object.assign({}, state.noiseParams);
        params.existingHeights = state.terrain.heights;
        var preview = TE.generateNoise(params);
        state.noisePreviewHeights = preview;
        drawGreyscale(el('noise-preview-canvas'), preview);
    }

    // -----------------------------------------------------------------------
    // Terrain creation helpers
    // -----------------------------------------------------------------------

    function newTerrain() {
        if (!confirm('Create a new flat terrain? Unsaved changes will be lost.')) return;
        state.terrain   = TE.createEmptyTerrain();
        state.undoStack = [];
        state.redoStack = [];
        state.dirty     = false;
        state.fileName  = null;
        TE.createTerrainMesh(state.terrain.heights);
        TE.createBrushCursor();
        refreshPreviewCanvas();
        updateStats();
        updateMaterialList();
        initRemapFromTerrain();
        state.smoothBase = null;
        setStatus('New terrain created.');
        updateUndoButtons();
        if (state.activeTab === 'texture') renderTextureTab();
        if (state.activeTab === 'edit2d')  draw2dCanvas();
        if (state.activeTab === 'imgedit') drawImgEditCanvas();
    }

    function importTer(file) {
        state.fileName = file.name;
        var reader = new FileReader();
        reader.onload = function (e) {
            try {
                state.terrain   = TE.parseTerFile(e.target.result);
                state.undoStack = [];
                state.redoStack = [];
                state.dirty     = false;
                TE.createTerrainMesh(state.terrain.heights);
                TE.createBrushCursor();
                refreshPreviewCanvas();
                updateStats();
                updateMaterialList();
                initRemapFromTerrain();
                state.smoothBase = null;
                setStatus('Loaded: ' + file.name);
                updateUndoButtons();
                if (state.activeTab === 'texture') renderTextureTab();
                if (state.activeTab === 'edit2d')  draw2dCanvas();
                if (state.activeTab === 'imgedit') drawImgEditCanvas();
            } catch (err) {
                alert('Error loading .ter file:\n' + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function importPngHeightmap(file) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
            URL.revokeObjectURL(url);
            var W = img.naturalWidth, H = img.naturalHeight;
            if (W !== 256 || H !== 256) {
                alert('PNG must be exactly 256×256 pixels.\nThis image is ' + W + '\xd7' + H + '.');
                return;
            }
            var tmp = document.createElement('canvas');
            tmp.width = 256; tmp.height = 256;
            var ctx = tmp.getContext('2d');
            ctx.drawImage(img, 0, 0);
            var imgData = ctx.getImageData(0, 0, 256, 256);
            var pixels  = imgData.data;

            // Find actual brightness range so we can normalise regardless of source range
            var lo = 255, hi = 0;
            for (var i = 0; i < pixels.length; i += 4) {
                var lum = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
                if (lum < lo) lo = lum;
                if (lum > hi) hi = lum;
            }
            var range = (hi > lo) ? (hi - lo) : 1;

            // Full state reset so switching between .ter and PNG import works cleanly
            state.terrain   = TE.createEmptyTerrain();
            state.undoStack = [];
            state.redoStack = [];
            state.dirty     = true;
            state.fileName  = null;

            var N2 = TE.BLOCK;
            for (var y = 0; y < N2; y++) {
                for (var x = 0; x < N2; x++) {
                    var pi   = (y * N2 + x) * 4;
                    var lum2 = (pixels[pi] + pixels[pi + 1] + pixels[pi + 2]) / 3;
                    var t    = (lum2 - lo) / range;
                    state.terrain.heights[x + y * N2] = t * TE.HMAX;
                }
            }

            TE.createTerrainMesh(state.terrain.heights);
            TE.createBrushCursor();

            // Immediately normalise imported heights to the [50, 250] default range
            TE.normaliseHeights(state.terrain.heights, 50, 250);

            refreshPreviewCanvas();
            updateStats();
            updateMaterialList();

            // Set remap state and sliders to reflect the applied [50, 250] range
            state.remapMin  = 50;
            state.remapMax  = 250;
            state.remapBase = new Float32Array(state.terrain.heights);
            syncSlider('remap-min', 'val-remap-min', 50, 50);
            syncSlider('remap-max', 'val-remap-max', 250, 250);

            state.smoothBase = null;
            setStatus('PNG heightmap imported and normalised: ' + file.name);
            updateUndoButtons();
            if (state.activeTab === 'texture') renderTextureTab();
            if (state.activeTab === 'edit2d')  draw2dCanvas();
            if (state.activeTab === 'imgedit') drawImgEditCanvas();
        };
        img.onerror = function () {
            URL.revokeObjectURL(url);
            alert('Failed to load PNG image.');
        };
        img.src = url;
    }

    function exportTer() {
        if (!state.terrain) { alert('No terrain loaded.'); return; }

        // If no texture slots are set, default slot 0 to DesertWorld.SandOrange
        // with a fully-opaque alpha map (all 255) so TGE renders something visible.
        var hasAnyTex = state.terrain.materialFileNames &&
                        state.terrain.materialFileNames.some(function (n) { return n && n.length > 0; });
        if (!hasAnyTex) {
            var n = TE.BLOCK * TE.BLOCK;
            if (!state.terrain.materialFileNames) {
                state.terrain.materialFileNames = new Array(TE.MAT_GROUPS).fill('');
            }
            state.terrain.materialFileNames[0] = 'DesertWorld.SandOrange';
            if (!state.terrain.materialAlphaMaps) {
                state.terrain.materialAlphaMaps = new Array(TE.MAT_GROUPS).fill(null);
            }
            var alphaFull = new Uint8Array(n);
            for (var i = 0; i < n; i++) alphaFull[i] = 255;
            state.terrain.materialAlphaMaps[0] = alphaFull;
        }

        var buf  = TE.serializeTerFile(state.terrain);
        var blob = new Blob([buf], { type: 'application/octet-stream' });
        var link = document.createElement('a');
        link.href     = URL.createObjectURL(blob);
        link.download = state.fileName || 'terrain.ter';
        link.click();
        state.dirty = false;
        setStatus('Exported: ' + (state.fileName || 'terrain.ter'));
    }

    /**
     * Export the current heightmap as a greyscale 8-bit PNG.
     * Heights are normalised over the terrain's actual min-max range.
     */
    function exportHeightmapPng() {
        if (!state.terrain) { alert('No terrain loaded.'); return; }
        var heights = state.terrain.heights;
        var N2 = TE.BLOCK;
        var lo = heights[0], hi = heights[0];
        for (var i = 1; i < heights.length; i++) {
            if (heights[i] < lo) lo = heights[i];
            if (heights[i] > hi) hi = heights[i];
        }
        var range = (hi - lo) || 1;
        var tmp = document.createElement('canvas');
        tmp.width  = N2;
        tmp.height = N2;
        var ctx  = tmp.getContext('2d');
        var idat = ctx.createImageData(N2, N2);
        for (var j = 0; j < N2 * N2; j++) {
            var v = Math.round(((heights[j] - lo) / range) * 255);
            idat.data[j * 4]     = v;
            idat.data[j * 4 + 1] = v;
            idat.data[j * 4 + 2] = v;
            idat.data[j * 4 + 3] = 255;
        }
        ctx.putImageData(idat, 0, 0);
        tmp.toBlob(function (blob) {
            var a = document.createElement('a');
            var base = (state.fileName || 'terrain').replace(/\.[^.]*$/, '');
            a.href     = URL.createObjectURL(blob);
            a.download = base + '_heightmap.png';
            a.click();
            setStatus('Heightmap PNG exported: ' + a.download);
        });
    }

    /**
     * After loading a terrain, seed the Remap Height sliders with the
     * terrain's actual min/max and take a fresh base snapshot.
     */
    function initRemapFromTerrain() {
        var s = TE.heightStats(state.terrain.heights);
        state.remapMin  = Math.round(s.min);
        state.remapMax  = Math.round(s.max);
        state.remapBase = new Float32Array(state.terrain.heights);
        syncSlider('remap-min', 'val-remap-min', state.remapMin, state.remapMin);
        syncSlider('remap-max', 'val-remap-max', state.remapMax, state.remapMax);
    }

    function updateMaterialList() {        var list = el('mat-list');
        if (!list || !state.terrain) return;
        list.innerHTML = '';
        var names = state.terrain.materialFileNames || [];
        for (var k = 0; k < TE.MAT_GROUPS; k++) {
            var row = document.createElement('div');
            row.className = 'mat-row';
            var lbl = document.createElement('span');
            lbl.className = 'mat-slot';
            lbl.textContent = 'Slot ' + (k + 1) + ':';
            var val = document.createElement('span');
            val.className = 'mat-name';
            val.textContent = (names[k] && names[k].length > 0) ? names[k] : '(empty)';
            val.style.color = (names[k] && names[k].length > 0) ? '#adf' : '#555';
            row.appendChild(lbl);
            row.appendChild(val);
            list.appendChild(row);
        }
    }

    // -----------------------------------------------------------------------
    // Tab switching
    // -----------------------------------------------------------------------

    // Layer colours for the alpha overlay (cycling through a palette)
    var OVERLAY_COLORS = [
        [0.1, 0.9, 0.5],   // green
        [0.2, 0.6, 1.0],   // blue
        [1.0, 0.5, 0.1],   // orange
        [0.9, 0.1, 0.9],   // magenta
        [1.0, 1.0, 0.1],   // yellow
        [0.1, 0.9, 1.0],   // cyan
        [1.0, 0.2, 0.2],   // red
        [0.6, 0.9, 0.2]    // lime
    ];

    function updateAlphaOverlay() {
        // No-op: texture tab now uses a 2D canvas instead of a 3D overlay.
        // Kept for compatibility in case called from old code paths.
    }

    /**
     * Clear stamp mode (hide controls, restore mirror, reset cursor).
     * Safe to call even when no stamp is loaded.
     */
    function clearStampMode() {
        state.edit2d.stamp.img     = null;
        state.edit2d.stamp.imgData = null;
        state.edit2d.mirrorEnabled = true;
        var btnMT = el('btn-mirror-toggle');
        if (btnMT) { btnMT.classList.add('active'); btnMT.textContent = '🪞 Mirror Line: On'; }
        var cv2d = el('edit2d-canvas');
        if (cv2d) cv2d.style.cursor = 'crosshair';
        var sc = el('stamp-controls');
        if (sc) sc.style.display = 'none';
    }

    function switchTab(tab) {
        // Clear stamp mode when leaving either 2D-canvas tab
        if ((state.activeTab === 'edit2d' || state.activeTab === 'imgedit') &&
            tab !== 'edit2d' && tab !== 'imgedit') {
            clearStampMode();
        }
        // Cancel paste preview when leaving imgedit; stop any active paint stroke but
        // preserve brush2dActive so the mode is still on when returning to this tab.
        if (state.activeTab === 'imgedit' && tab !== 'imgedit') {
            state.imgEdit.pastePreview     = null;
            state.imgEdit.pasteDragging    = false;
            state.imgEdit.pasteScaleHandle = null;
            state.imgEdit.pasteScaleDragStart = null;
            // Stop any in-progress paint stroke; leave brush2dActive intact so
            // the user does not have to re-enable it when coming back to this tab.
            if (state.imgEdit.brush2dActive) {
                state.imgEdit.brush2dPainting = false;
                state.imgEdit.brush2dGX       = -1;
                state.imgEdit.brush2dGY       = -1;
            }
        }
        // Reset tex brush position when leaving texture tab
        if (state.activeTab === 'texture' && tab !== 'texture') {
            state.texBrushGX = -1;
            state.texBrushGY = -1;
            state.texMouseDown = false;
        }

        state.activeTab = tab;
        document.querySelectorAll('.tab-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tab === tab);
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
            p.classList.toggle('active', p.dataset.panel === tab);
        });

        var renderCanvas  = el('render-canvas');
        var edit2dCanvas  = el('edit2d-canvas');
        var vpOverlay     = document.querySelector('.viewport-overlay');
        var fcBar         = el('fly-cam-bar');

        if (tab === 'edit2d') {
            if (renderCanvas) renderCanvas.style.display = 'none';
            if (edit2dCanvas) { edit2dCanvas.style.display = 'block'; edit2dCanvas.style.cursor = 'crosshair'; }
            if (vpOverlay)    vpOverlay.style.display    = 'none';
            if (fcBar)        fcBar.style.display        = 'none';
            draw2dCanvas();
        } else if (tab === 'texture') {
            // Show the 2D canvas with the current alpha layer (no 3D view)
            if (renderCanvas) renderCanvas.style.display = 'none';
            if (edit2dCanvas) { edit2dCanvas.style.display = 'block'; edit2dCanvas.style.cursor = 'crosshair'; }
            if (vpOverlay)    vpOverlay.style.display    = 'none';
            if (fcBar)        fcBar.style.display        = 'none';
            renderTextureTab();
            drawTexCanvas();
        } else if (tab === 'imgedit') {
            // Image-editor style heightmap editor — uses the same 2D canvas
            if (renderCanvas) renderCanvas.style.display = 'none';
            if (edit2dCanvas) {
                edit2dCanvas.style.display = 'block';
                edit2dCanvas.style.cursor  = state.imgEdit.brush2dActive ? 'none' : 'crosshair';
            }
            if (vpOverlay) vpOverlay.style.display = 'none';
            if (fcBar)     fcBar.style.display     = 'none';
            imgEditUpdateInfo();
            drawImgEditCanvas();
        } else {
            if (renderCanvas) renderCanvas.style.display = 'block';
            if (edit2dCanvas) edit2dCanvas.style.display = 'none';
            if (vpOverlay)    vpOverlay.style.display    = '';
            // Restore fly-cam bar if fly mode is active
            if (fcBar) fcBar.style.display = (TE.getCamMode && TE.getCamMode() === 'fly') ? 'flex' : 'none';

            if (tab === 'paint') {
                renderCanvas.style.cursor = 'crosshair';
            } else {
                renderCanvas.style.cursor = 'default';
                TE.updateBrushCursor(null, 0);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tool selection
    // -----------------------------------------------------------------------

    function selectTool(tool) {
        state.activeTool = tool;
        document.querySelectorAll('.tool-btn').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tool === tool);
        });
        // Show/hide tool-specific option rows
        document.querySelectorAll('.tool-option').forEach(function (r) {
            r.style.display = r.dataset.tools.split(',').indexOf(tool) >= 0 ? '' : 'none';
        });
    }

    // -----------------------------------------------------------------------
    // Brush application
    // -----------------------------------------------------------------------

    /**
     * Apply the current brush tool at grid position (gx, gy), plus any
     * symmetrical positions according to state.brushSymmetry.
     */
    function applyBrushAt(gx, gy) {
        if (!state.terrain) return;

        var h  = state.terrain.heights;
        var r  = state.brushRadius;
        var s  = state.brushStrength;
        var fo = state.brushFalloff;
        var N2 = TE.BLOCK;
        var sym = state.brushSymmetry;

        // Collect all positions to paint: primary + symmetric mirrors
        var positions = [{ x: gx, y: gy }];
        if (sym === 'horizontal' || sym === 'central') {
            positions.push({ x: N2 - 1 - gx, y: gy });
        }
        if (sym === 'vertical' || sym === 'central') {
            positions.push({ x: gx, y: N2 - 1 - gy });
        }
        if (sym === 'central') {
            positions.push({ x: N2 - 1 - gx, y: N2 - 1 - gy });
        }

        var rInt  = Math.ceil(r);
        var Nmax  = N2 - 1;
        var dirty = {
            x0: Math.max(0,    Math.round(gx) - rInt),
            x1: Math.min(Nmax, Math.round(gx) + rInt),
            y0: Math.max(0,    Math.round(gy) - rInt),
            y1: Math.min(Nmax, Math.round(gy) + rInt)
        };

        for (var pi = 0; pi < positions.length; pi++) {
            var cx = positions[pi].x, cy = positions[pi].y;
            switch (state.activeTool) {
                case 'raise':        TE.brushRaise(h, cx, cy, r, s, fo);                         break;
                case 'lower':        TE.brushLower(h, cx, cy, r, s, fo);                         break;
                case 'flatten':      TE.brushFlatten(h, cx, cy, r, s, fo);                       break;
                case 'smooth':       TE.brushSmooth(h, cx, cy, r, s, fo);                        break;
                case 'setHeight':    TE.brushSetHeight(h, cx, cy, r, s, fo, state.targetHeight); break;
                case 'slope':        TE.brushSlope(h, cx, cy, r, s, fo);                         break;
                case 'twist':        TE.brushTwist(h, cx, cy, r, s, fo);                         break;
                // 'adjustHeight' is handled separately via mouse-Y delta in onPointerMove
            }
            // Expand dirty region to cover all painted positions
            dirty.x0 = Math.min(dirty.x0, Math.max(0,    Math.round(cx) - rInt));
            dirty.x1 = Math.max(dirty.x1, Math.min(Nmax, Math.round(cx) + rInt));
            dirty.y0 = Math.min(dirty.y0, Math.max(0,    Math.round(cy) - rInt));
            dirty.y1 = Math.max(dirty.y1, Math.min(Nmax, Math.round(cy) + rInt));
        }

        TE.updateTerrainHeights(h, dirty);

        // Throttled preview update (every ~10 frames is fine for 3D; greyscale is fast)
        refreshPreviewCanvas();
        state.dirty = true;
    }

    // -----------------------------------------------------------------------
    // Mouse / pointer events on the 3D canvas
    // -----------------------------------------------------------------------

    function onPointerDown(evt) {
        if (state.activeTab !== 'paint') return;
        if (!state.terrain) return;

        // Middle-click in Set Height mode: pick height at cursor
        if (evt.button === 1 && state.activeTool === 'setHeight') {
            evt.preventDefault();
            var hitPick = TE.pickTerrain();
            if (hitPick) {
                var idx = Math.round(hitPick.gx) + Math.round(hitPick.gy) * 256;
                var pickedH = state.terrain.heights[idx];
                state.targetHeight = pickedH;
                var inp = el('input-target-height');
                if (inp) inp.value = pickedH.toFixed(0);
                setStatus('Target height set to ' + pickedH.toFixed(2) + ' m');
            }
            return;
        }

        if (evt.button !== 0) return;           // only left-click paints

        evt.preventDefault();
        evt.stopPropagation();

        // In arc mode, detach camera so left-drag paints instead of orbiting.
        if (TE.getCamMode() === 'arc') {
            var cam = TE.getCamera();
            if (cam) cam.detachControl();
        }

        if (state.activeTool === 'adjustHeight') {
            // Snap a snapshot and record the brush centre; drag does the work
            var hitAdj = TE.pickTerrain();
            if (!hitAdj) return;
            pushUndo();
            state.adjustLocked   = true;
            state.adjustBaseY    = evt.clientY;
            state.adjustBrushGX  = hitAdj.gx;
            state.adjustBrushGY  = hitAdj.gy;
            state.adjustSnapshot = new Float32Array(state.terrain.heights);
            return;
        }

        pushUndo();
        state.mouseDown  = true;
        state.lastBrushX = -1;
        state.lastBrushY = -1;

        var hit = TE.pickTerrain();
        if (hit) {
            applyBrushAt(hit.gx, hit.gy);
            state.lastBrushX = hit.gx;
            state.lastBrushY = hit.gy;
        }
    }

    function onPointerMove(evt) {
        // Only handle 3D paint tab here; texture tab painting is on edit2d-canvas
        if (state.activeTab !== 'paint') return;

        // During Adjust Height drag: cursor stays locked at the initial click position;
        // do NOT let it follow the mouse.
        if (state.adjustLocked && state.adjustSnapshot) {
            var dy = state.adjustBaseY - evt.clientY; // positive = up = raise
            // Scale: each pixel = 0.5 m * strength modifier
            var delta = dy * 0.5 * (state.brushStrength / 5.0);
            state.terrain.heights.set(state.adjustSnapshot);
            TE.brushAdjust(
                state.terrain.heights,
                state.adjustBrushGX, state.adjustBrushGY,
                state.brushRadius, delta, state.brushFalloff
            );
            var r2   = Math.ceil(state.brushRadius);
            var gxR  = Math.round(state.adjustBrushGX);
            var gyR  = Math.round(state.adjustBrushGY);
            TE.updateTerrainHeights(state.terrain.heights, {
                x0: Math.max(0, gxR - r2), x1: Math.min(255, gxR + r2),
                y0: Math.max(0, gyR - r2), y1: Math.min(255, gyR + r2)
            });

            // Redraw brush cursor at the locked world position with the updated heights,
            // so the indicator squares visually rise/fall with the terrain.
            var lockedWX = (state.adjustBrushGX - 128) * TE.SCALE;
            var lockedWZ = (state.adjustBrushGY - 128) * TE.SCALE;
            var lockedWY = state.terrain.heights[gxR + gyR * 256];
            TE.updateBrushCursor(
                new BABYLON.Vector3(lockedWX, lockedWY, lockedWZ),
                state.brushRadius,
                state.terrain.heights,
                state.brushFalloff,
                true  // forceRebuild so height changes are reflected immediately
            );

            refreshPreviewCanvas();
            state.dirty = true;
            return;
        }

        var hit = TE.pickTerrain();
        if (hit) {
            TE.updateBrushCursor(
                hit.world,
                state.brushRadius,
                state.terrain ? state.terrain.heights : null,
                state.brushFalloff
            );

            if (state.terrain) {
                var idx = Math.round(hit.gx) + Math.round(hit.gy) * 256;
                var h   = state.terrain.heights[idx];
                var e   = el('status-cursor');
                if (e) e.textContent = 'Grid: ' + Math.round(hit.gx) + ', ' +
                                       Math.round(hit.gy) + '  |  Height: ' + h.toFixed(2) + ' m';
            }
        } else {
            TE.updateBrushCursor(null, 0);
            var e = el('status-cursor');
            if (e) e.textContent = '';
        }

        if (!state.mouseDown || !hit) return;

        // Only re-apply when the cursor has moved at least half a cell to avoid
        // excessive same-spot stacking on slow machines
        var dx = hit.gx - state.lastBrushX;
        var dy2 = hit.gy - state.lastBrushY;
        if (dx * dx + dy2 * dy2 < 0.25) return;
        applyBrushAt(hit.gx, hit.gy);
        state.lastBrushX = hit.gx;
        state.lastBrushY = hit.gy;
    }

    function onPointerUp(evt) {
        if (state.adjustLocked) {
            state.adjustLocked   = false;
            state.adjustSnapshot = null;
            updateStats();
            if (TE.getCamMode() === 'arc') {
                var cam2 = TE.getCamera();
                if (cam2) cam2.attachControl(el('render-canvas'), true);
            }
            return;
        }
        if (!state.mouseDown) return;
        state.mouseDown = false;
        updateStats();
        // Restore camera control only in arc mode (fly camera was never detached)
        if (TE.getCamMode() === 'arc') {
            var cam = TE.getCamera();
            if (cam) cam.attachControl(el('render-canvas'), true);
        }
    }

    // -----------------------------------------------------------------------
    // Keyboard shortcuts
    // -----------------------------------------------------------------------

    function onKeyDown(evt) {
        // Ignore when typing in an input
        if (['INPUT', 'SELECT', 'TEXTAREA'].indexOf(evt.target.tagName) >= 0) return;

        var key = evt.key.toLowerCase();



        // 2D Edit (imgedit) shortcuts — handled before fly-mode suppression so
        // they always work regardless of camera state.
        if (state.activeTab === 'imgedit') {
            // Escape — cancel paste preview or clear selection
            if (evt.key === 'Escape') {
                var ie2 = state.imgEdit;
                if (ie2.pastePreview) {
                    ie2.pastePreview      = null;
                    ie2.pasteDragging     = false;
                    ie2.pasteDragStart    = null;
                    ie2.pasteScaleHandle  = null;
                    ie2.pasteScaleDragStart = null;
                    var cv2dEsc = el('edit2d-canvas');
                    if (cv2dEsc) cv2dEsc.style.cursor = 'crosshair';
                    imgEditUpdateInfo();
                    drawImgEditCanvas();
                    setStatus('Paste cancelled.');
                } else if (ie2.selection) {
                    ie2.selection = null;
                    ie2.mask = null;
                    ie2.lassoPoints = [];
                    ie2.ellipse = null;
                    imgEditUpdateInfo();
                    drawImgEditCanvas();
                    setStatus('Selection cleared.');
                }
                evt.preventDefault();
                return;
            }

            // Ctrl+C — copy selection
            if ((evt.ctrlKey || evt.metaKey) && key === 'c') {
                evt.preventDefault();
                var ieCopy = state.imgEdit;
                if (!state.terrain) { setStatus('Load or create a terrain first.'); return; }
                if (!ieCopy.selection) { setStatus('Make a selection first, then copy.'); return; }
                copySelectionToClipboard();
                var cb = ieCopy.clipboard;
                setHTML('imgedit-clip-info', cb ? 'Clipboard: ' + cb.w + '\xd7' + cb.h + ' cells' : 'Clipboard: empty');
                setStatus('Copied ' + (cb ? cb.w + '\xd7' + cb.h : '0') + ' cells to clipboard.');
                return;
            }

            // Ctrl+V — paste
            if ((evt.ctrlKey || evt.metaKey) && key === 'v') {
                evt.preventDefault();
                var iePaste = state.imgEdit;
                if (!state.terrain) { setStatus('Load or create a terrain first.'); return; }
                loadClipboardFromStorage();
                if (!iePaste.clipboard) { setStatus('Clipboard is empty \u2014 copy or cut something first.'); return; }
                var ox = iePaste.selection ? iePaste.selection.x0 : 0;
                var oy = iePaste.selection ? iePaste.selection.y0 : 0;
                iePaste.pastePreview = {
                    data          : new Float32Array(iePaste.clipboard.data),
                    origData      : iePaste.clipboard.data,
                    w             : iePaste.clipboard.w,
                    h             : iePaste.clipboard.h,
                    origW         : iePaste.clipboard.w,
                    origH         : iePaste.clipboard.h,
                    ox            : ox,
                    oy            : oy,
                    mask          : iePaste.clipboard.mask ? new Uint8Array(iePaste.clipboard.mask) : null,
                    origMask      : iePaste.clipboard.mask || null,
                    rotation      : 0,
                    alphaMaps     : iePaste.clipboard.alphaMaps
                        ? iePaste.clipboard.alphaMaps.map(function (a) { return a ? new Uint8Array(a) : null; })
                        : null,
                    origAlphaMaps : iePaste.clipboard.alphaMaps || null
                };
                var cv2dPaste = el('edit2d-canvas');
                if (cv2dPaste) cv2dPaste.style.cursor = 'move';
                var paEl = el('imgedit-paste-actions');
                if (paEl) paEl.style.display = '';
                setHTML('imgedit-clip-info', 'Clipboard: ' + iePaste.clipboard.w + '\xd7' + iePaste.clipboard.h + ' cells');
                drawImgEditCanvas();
                setStatus('Paste preview \u2014 drag to position, scroll to rotate, middle-click to stamp, right-click to cancel.');
                return;
            }
        }

        // Undo / Redo — available in all camera modes, including fly
        if ((evt.ctrlKey || evt.metaKey) && key === 'z' && !evt.shiftKey) { evt.preventDefault(); undo(); return; }
        if ((evt.ctrlKey || evt.metaKey) && (key === 'y' || (evt.shiftKey && key === 'z'))) { evt.preventDefault(); redo(); return; }

        // In fly mode all remaining shortcuts are suppressed to avoid clashing
        // with WASD/Q/E/W/F/T/1-7 movement and look keys consumed by the camera.
        if (TE.getCamMode() === 'fly') return;

        // Brush radius  [ and ]
        if (key === '[') { adjustBrushRadius(-2); }
        if (key === ']') { adjustBrushRadius( 2); }

        // Brush strength  - and =
        if (key === '-' || key === '_') { adjustBrushStrength(-1); }
        if (key === '=' || key === '+') { adjustBrushStrength( 1); }

        // Tool shortcuts (1-8)
        var tools = ['raise','lower','flatten','smooth','setHeight','adjustHeight','slope','twist'];
        var num   = parseInt(evt.key) - 1;
        if (num >= 0 && num < tools.length) selectTool(tools[num]);

        // Camera shortcuts (arc mode only)

        // Wireframe
    }

    function adjustBrushRadius(delta) {
        state.brushRadius = Math.max(1, Math.min(50, state.brushRadius + delta));
        syncSlider('slider-radius', 'val-radius', state.brushRadius, state.brushRadius.toFixed(0));
        TE.updateBrushCursor(null, 0); // will be updated on next mouse move
    }

    function adjustBrushStrength(delta) {
        state.brushStrength = Math.max(0.5, Math.min(25, state.brushStrength + delta));
        syncSlider('slider-strength', 'val-strength', state.brushStrength, state.brushStrength.toFixed(1));
    }

    function syncSlider(sliderId, valueId, val, display) {
        var s = el(sliderId); if (s) s.value = val;
        var v = el(valueId);  if (v) v.textContent = display !== undefined ? display : val;
    }

    // -----------------------------------------------------------------------
    // Alpha paint helper (texture tab)
    // -----------------------------------------------------------------------

    function applyAlphaPaintAt(gx, gy) {
        if (!state.terrain) return;
        var k = state.texPaint.layer;
        if (!state.terrain.materialAlphaMaps) {
            state.terrain.materialAlphaMaps = new Array(TE.MAT_GROUPS).fill(null);
        }
        if (!state.terrain.materialAlphaMaps[k]) {
            state.terrain.materialAlphaMaps[k] = new Uint8Array(TE.BLOCK * TE.BLOCK);
        }
        var alphaMap = state.terrain.materialAlphaMaps[k];
        var value    = state.texPaint.mode === 'erase'
                       ? -state.texPaint.strength
                       :  state.texPaint.strength;
        TE.paintAlpha(alphaMap, gx, gy, state.texPaint.radius, value, state.texPaint.falloff);
        state.dirty = true;
    }

    // -----------------------------------------------------------------------
    // UI wiring
    // -----------------------------------------------------------------------

    function bindSlider(sliderId, valueId, toFixed, onchange) {
        var slider = el(sliderId);
        var label  = el(valueId);
        if (!slider) return;
        slider.addEventListener('input', function () {
            var v = parseFloat(slider.value);
            if (label) label.textContent = v.toFixed(toFixed);
            onchange(v);
        });
    }

    function wireUI() {
        // File buttons
        el('btn-new').addEventListener('click', newTerrain);
        el('btn-import').addEventListener('click', function () { el('file-input').click(); });
        el('file-input').addEventListener('change', function (e) {
            if (e.target.files[0]) importTer(e.target.files[0]);
            e.target.value = '';
        });
        el('btn-import-png').addEventListener('click', function () { el('png-hm-input').click(); });
        el('png-hm-input').addEventListener('change', function (e) {
            if (e.target.files[0]) importPngHeightmap(e.target.files[0]);
            e.target.value = '';
        });
        el('btn-export').addEventListener('click', exportTer);
        el('btn-export-png-hm').addEventListener('click', exportHeightmapPng);

        // Tabs
        document.querySelectorAll('.tab-btn').forEach(function (b) {
            b.addEventListener('click', function () { switchTab(b.dataset.tab); });
        });

        // Tool buttons
        document.querySelectorAll('.tool-btn').forEach(function (b) {
            b.addEventListener('click', function () { selectTool(b.dataset.tool); });
        });

        // Undo / Redo
        el('btn-undo').addEventListener('click', undo);
        el('btn-redo').addEventListener('click', redo);

        // Brush sliders
        bindSlider('slider-radius', 'val-radius', 0, function (v) { state.brushRadius = v; });
        bindSlider('slider-strength', 'val-strength', 1, function (v) { state.brushStrength = v; });

        var falloffSel = el('sel-falloff');
        if (falloffSel) {
            falloffSel.addEventListener('change', function () {
                state.brushFalloff = falloffSel.value;
            });
        }

        var symmetrySel = el('sel-symmetry');
        if (symmetrySel) {
            symmetrySel.addEventListener('change', function () {
                state.brushSymmetry = symmetrySel.value;
            });
        }

        var targetHInput = el('input-target-height');
        if (targetHInput) {
            targetHInput.addEventListener('change', function () {
                state.targetHeight = parseFloat(targetHInput.value) || 0;
            });
        }

        var scaleInput = el('input-scale-factor');
        if (scaleInput) {
            scaleInput.addEventListener('change', function () {
                // scale tool removed; this element may be absent
            });
        }

        // Suppress middle-click scroll while over the render canvas (for Set Height pick)
        var renderCanvas = el('render-canvas');
        if (renderCanvas) {
            renderCanvas.addEventListener('auxclick', function (e) {
                if (e.button === 1) { e.preventDefault(); }
            });
            renderCanvas.addEventListener('mousedown', function (e) {
                if (e.button === 1) { e.preventDefault(); }
            });
        }

        // View tab overlay buttons
        el('btn-wireframe').addEventListener('click', function () {
            state.wireframe = !state.wireframe;
            TE.setWireframe(state.wireframe);
            el('btn-wireframe').classList.toggle('active', state.wireframe);
        });

        el('btn-grid').addEventListener('click', function () {
            state.showGrid = !state.showGrid;
            TE.setGridVisible(state.showGrid);
            el('btn-grid').classList.toggle('active', state.showGrid);
        });

        el('btn-reset-cam').addEventListener('click', function () {
            if (TE.getCamMode() === 'fly') {
                TE.toggleFlyCam();
                el('btn-fly').classList.remove('active');
                var fcBarR = el('fly-cam-bar');
                if (fcBarR) fcBarR.style.display = 'none';
            }
            TE.resetCamera();
        });
        el('btn-top-cam').addEventListener('click', function () {
            if (TE.getCamMode() === 'fly') {
                TE.toggleFlyCam();
                el('btn-fly').classList.remove('active');
                var fcBarT = el('fly-cam-bar');
                if (fcBarT) fcBarT.style.display = 'none';
            }
            TE.topDownCamera();
        });

        el('btn-fly').addEventListener('click', function () {
            var newMode = TE.toggleFlyCam();
            el('btn-fly').classList.toggle('active', newMode === 'fly');
            var fcBar = el('fly-cam-bar');
            if (fcBar) fcBar.style.display = newMode === 'fly' ? 'flex' : 'none';
            setStatus(newMode === 'fly'
                ? 'Fly mode — WASD/Q/E to move, right-drag to look. Press C or Fly to exit.'
                : 'Orbit camera restored.');
        });

        // Fly-cam speed / look speed sliders
        (function () {
            var speedSlider = el('fly-speed-slider');
            var lookSlider  = el('fly-look-slider');
            var speedVal    = el('val-fly-speed');
            var lookVal     = el('val-fly-look');
            if (speedSlider) {
                speedSlider.addEventListener('input', function () {
                    var v = parseInt(speedSlider.value);
                    if (speedVal) speedVal.textContent = v;
                    TE.setFlyCamSpeed(v);
                });
            }
            if (lookSlider) {
                lookSlider.addEventListener('input', function () {
                    var v = parseInt(lookSlider.value);
                    if (lookVal) lookVal.textContent = v;
                    TE.setFlyCamLookSpeed(v);
                });
            }
        }());

        // Global terrain ops – Smooth All
        (function () {
            var strengthSlider = el('smooth-all-strength');
            var passesSlider   = el('smooth-all-passes');
            var strengthVal    = el('val-smooth-strength');
            var passesVal      = el('val-smooth-passes');

            function previewSmooth() {
                if (!state.terrain) return;
                // Lazily take base snapshot on first preview in a session
                if (!state.smoothBase) {
                    state.smoothBase = new Float32Array(state.terrain.heights);
                }
                // Apply to a temporary copy so base is not mutated
                var temp = new Float32Array(state.smoothBase);
                TE.smoothAll(temp, state.smoothAllPasses, state.smoothAllStrength);
                state.terrain.heights.set(temp);
                applyHeightsToAll();
            }

            if (strengthSlider) {
                strengthSlider.addEventListener('input', function () {
                    state.smoothAllStrength = parseFloat(strengthSlider.value);
                    if (strengthVal) strengthVal.textContent = state.smoothAllStrength.toFixed(2);
                    previewSmooth();
                });
            }
            if (passesSlider) {
                passesSlider.addEventListener('input', function () {
                    state.smoothAllPasses = parseInt(passesSlider.value);
                    if (passesVal) passesVal.textContent = state.smoothAllPasses;
                    previewSmooth();
                });
            }

            el('btn-smooth-all-apply').addEventListener('click', function () {
                if (!state.terrain) return;
                if (state.smoothBase) {
                    // Push the pre-smooth snapshot as the undo entry
                    state.undoStack.push(new Float32Array(state.smoothBase));
                    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
                    state.redoStack = [];
                    state.dirty = true;
                    updateUndoButtons();
                    state.smoothBase = null;
                } else {
                    // No preview yet — apply once with normal undo
                    pushUndo();
                    TE.smoothAll(state.terrain.heights, state.smoothAllPasses, state.smoothAllStrength);
                    applyHeightsToAll();
                }
                setStatus('Smooth applied (strength: ' + state.smoothAllStrength.toFixed(2) +
                          ', passes: ' + state.smoothAllPasses + ').');
            });
        }());

        // Global terrain ops – Remap Heights
        (function () {
            var minSlider = el('remap-min');
            var maxSlider = el('remap-max');
            var minVal    = el('val-remap-min');
            var maxVal    = el('val-remap-max');

            function previewRemap() {
                if (!state.terrain) return;
                if (!state.remapBase) {
                    state.remapBase = new Float32Array(state.terrain.heights);
                }
                var temp = new Float32Array(state.remapBase);
                TE.normaliseHeights(temp, state.remapMin, state.remapMax);
                state.terrain.heights.set(temp);
                applyHeightsToAll();
            }

            if (minSlider) {
                minSlider.addEventListener('input', function () {
                    state.remapMin = parseFloat(minSlider.value);
                    if (minVal) minVal.textContent = Math.round(state.remapMin);
                    // Keep min < max
                    if (state.remapMin >= state.remapMax) {
                        state.remapMax = state.remapMin + 1;
                        if (maxSlider) maxSlider.value = state.remapMax;
                        if (maxVal)    maxVal.textContent = Math.round(state.remapMax);
                    }
                    previewRemap();
                });
            }
            if (maxSlider) {
                maxSlider.addEventListener('input', function () {
                    state.remapMax = parseFloat(maxSlider.value);
                    if (maxVal) maxVal.textContent = Math.round(state.remapMax);
                    if (state.remapMax <= state.remapMin) {
                        state.remapMin = Math.max(0, state.remapMax - 1);
                        if (minSlider) minSlider.value = state.remapMin;
                        if (minVal)    minVal.textContent = Math.round(state.remapMin);
                    }
                    previewRemap();
                });
            }

            el('btn-remap-apply').addEventListener('click', function () {
                if (!state.terrain) return;
                if (state.remapBase) {
                    state.undoStack.push(new Float32Array(state.remapBase));
                    if (state.undoStack.length > MAX_UNDO) state.undoStack.shift();
                    state.redoStack = [];
                    state.dirty = true;
                    updateUndoButtons();
                    state.remapBase = new Float32Array(state.terrain.heights);
                } else {
                    pushUndo();
                    TE.normaliseHeights(state.terrain.heights, state.remapMin, state.remapMax);
                    applyHeightsToAll();
                    state.remapBase = new Float32Array(state.terrain.heights);
                }
                setStatus('Heights remapped to ' + Math.round(state.remapMin) +
                          '–' + Math.round(state.remapMax) + ' m.');
            });
        }());

        // Global terrain ops – Edge Smooth
        (function () {
            var marginSlider = el('edge-smooth-margin');
            var marginVal    = el('val-edge-smooth-margin');

            if (marginSlider) {
                marginSlider.addEventListener('input', function () {
                    if (marginVal) marginVal.textContent = marginSlider.value;
                });
            }

            var applyBtn = el('btn-edge-smooth-apply');
            if (applyBtn) {
                applyBtn.addEventListener('click', function () {
                    if (!state.terrain) return;
                    pushUndo();
                    var margin = marginSlider ? parseInt(marginSlider.value) : 24;
                    TE.edgeSmooth(state.terrain.heights, margin);
                    applyHeightsToAll();
                    setStatus('Edge smooth applied (margin: ' + margin + ' cells).');
                });
            }
        }());

        // Noise tab
        wireNoiseTab();

        // Texture tab
        wireTextureTab();

        // Keyboard
        window.addEventListener('keydown', onKeyDown);

        // 3D canvas pointer events
        var canvas = el('render-canvas');
        canvas.addEventListener('pointerdown',  onPointerDown);
        canvas.addEventListener('pointermove',  onPointerMove);
        canvas.addEventListener('pointerup',    onPointerUp);
        canvas.addEventListener('pointerleave', function () {
            TE.updateBrushCursor(null, 0);
        });

        // Track right-mouse-button state for the wheel sensitivity adjustment
        var rightMouseHeld = false;
        canvas.addEventListener('mousedown',  function (e) { if (e.button === 2) rightMouseHeld = true;  });
        canvas.addEventListener('mouseup',    function (e) { if (e.button === 2) rightMouseHeld = false; });
        canvas.addEventListener('mouseleave', function ()  { rightMouseHeld = false; });

        // Mouse-wheel in fly mode:
        //   plain scroll       → adjust fly speed
        //   right-click + scroll → adjust look sensitivity (lower = faster)
        canvas.addEventListener('wheel', function (e) {
            if (TE.getCamMode() !== 'fly') return;
            e.preventDefault();
            // deltaY > 0 = scroll down = "decrease" (slow down / slower look)
            var zoomIn = e.deltaY < 0;
            if (rightMouseHeld) {
                // Adjust look sensitivity: scroll-up → faster look (lower value)
                var newSens = TE.adjustFlyCamSensitivity(zoomIn ? 0.85 : 1.18);
                setStatus('Look sensitivity: ' + Math.round(newSens));
            } else {
                // Adjust fly speed: scroll-up → faster
                var newSpeed = TE.adjustFlyCamSpeed(zoomIn ? 1.2 : 0.83);
                setStatus('Fly speed: ' + Math.round(newSpeed));
            }
        }, { passive: false });

        // Prevent context menu everywhere (avoids keybind lock-ups on right-click)
        document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        // Prevent context menu on canvas
        canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

        // Greyscale preview: drag to scroll terrain data toroidally (wrapping shift)
        // so you can reposition any terrain feature to the centre.
        (function () {
            var pc = el('preview-canvas');
            if (!pc) return;
            var drag = {
                active      : false,
                startX      : 0,
                startY      : 0,
                snapshot    : null,   // frozen copy of heights at drag start
                alphaSnaps  : null    // array of Uint8Array snapshots of alpha maps
            };

            // Toroidal scroll of a Uint8Array grid (same 256×256 layout as heights)
            function scrollAlphaMap(dest, src, dx, dy) {
                var N2 = TE.BLOCK;
                dx = ((dx % N2) + N2) % N2;
                dy = ((dy % N2) + N2) % N2;
                for (var y = 0; y < N2; y++) {
                    var sy = (y - dy + N2) % N2;
                    for (var x = 0; x < N2; x++) {
                        var sx = (x - dx + N2) % N2;
                        dest[y * N2 + x] = src[sy * N2 + sx];
                    }
                }
            }

            pc.addEventListener('pointerdown', function (e) {
                if (!state.terrain) return;
                drag.active   = true;
                drag.startX   = e.clientX;
                drag.startY   = e.clientY;
                drag.snapshot = new Float32Array(state.terrain.heights);
                // Snapshot all alpha maps for toroidal scrolling
                var maps = state.terrain.materialAlphaMaps || [];
                drag.alphaSnaps = maps.map(function (m) {
                    return m ? new Uint8Array(m) : null;
                });
                pc.setPointerCapture(e.pointerId);
                pushUndo();
            });

            pc.addEventListener('pointermove', function (e) {
                if (!drag.active) return;
                var rect    = pc.getBoundingClientRect();
                var ppCell  = rect.width / TE.BLOCK;          // preview pixels per terrain cell
                var cellDX  = Math.round((e.clientX - drag.startX) / ppCell);
                var cellDY  = Math.round((e.clientY - drag.startY) / ppCell);
                TE.scrollTerrain(state.terrain.heights, drag.snapshot, cellDX, cellDY);
                TE.updateTerrainHeights(state.terrain.heights, null);
                // Scroll all alpha maps by the same delta
                if (state.terrain.materialAlphaMaps && drag.alphaSnaps) {
                    for (var k = 0; k < state.terrain.materialAlphaMaps.length; k++) {
                        if (state.terrain.materialAlphaMaps[k] && drag.alphaSnaps[k]) {
                            scrollAlphaMap(
                                state.terrain.materialAlphaMaps[k],
                                drag.alphaSnaps[k],
                                cellDX, cellDY
                            );
                        }
                    }
                }
                refreshPreviewCanvas();
                if (state.activeTab === 'edit2d')  draw2dCanvas();
                if (state.activeTab === 'texture') drawTexCanvas();
                if (state.activeTab === 'imgedit') drawImgEditCanvas();
            });

            pc.addEventListener('pointerup', function () {
                drag.active      = false;
                drag.snapshot    = null;
                drag.alphaSnaps  = null;
                updateStats();
                if (state.activeTab === 'texture') { renderTextureTab(); drawTexCanvas(); }
            });
            pc.addEventListener('pointerleave', function (e) {
                if (!e.buttons) {
                    drag.active     = false;
                    drag.snapshot   = null;
                    drag.alphaSnaps = null;
                }
            });
        }());

        // Wire 2D Edit (Mirror Mode) tab
        wireEdit2dTab();
        // Wire 2D Edit (image-editor) tab
        wireImgEditTab();
    }

    // -----------------------------------------------------------------------
    // 2D Edit tab wiring
    // -----------------------------------------------------------------------

    function wireEdit2dTab() {
        // ── Flip & Rotate ──────────────────────────────────────────────────
        el('btn-flip-h').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.flipHeights(state.terrain.heights, 'h');
            applyHeightsToAll();
            setStatus('Heightmap flipped horizontally.');
        });

        el('btn-flip-v').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.flipHeights(state.terrain.heights, 'v');
            applyHeightsToAll();
            setStatus('Heightmap flipped vertically.');
        });

        el('btn-rotate-ccw').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.rotateHeights(state.terrain.heights, 'ccw');
            applyHeightsToAll();
            setStatus('Heightmap rotated 90° counter-clockwise.');
        });

        el('btn-rotate-cw').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.rotateHeights(state.terrain.heights, 'cw');
            applyHeightsToAll();
            setStatus('Heightmap rotated 90° clockwise.');
        });

        var mirrorSlider = el('mirror-angle');

        function setMirrorAngle(deg) {
            state.edit2d.mirrorAngle = deg;
            if (mirrorSlider) mirrorSlider.value = deg;
            setHTML('val-mirror-angle', deg + '°');
            if (state.activeTab === 'edit2d') draw2dCanvas();
        }

        if (mirrorSlider) {
            mirrorSlider.addEventListener('input', function () {
                setMirrorAngle(parseInt(mirrorSlider.value));
            });
        }

        // Preset angle buttons
        el('btn-mirror-v').addEventListener('click',  function () { setMirrorAngle(0);   });
        el('btn-mirror-h').addEventListener('click',  function () { setMirrorAngle(90);  });
        el('btn-mirror-d1').addEventListener('click', function () { setMirrorAngle(45);  });
        el('btn-mirror-d2').addEventListener('click', function () { setMirrorAngle(135); });

        // Mirror apply buttons
        el('btn-mirror-a-to-b').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.mirrorTerrain(state.terrain.heights, state.edit2d.mirrorAngle, 'srcA', state.edit2d.mirrorAlsoFlip);
            applyHeightsToAll();
            setStatus('Mirrored A→B at ' + state.edit2d.mirrorAngle + '°.');
        });

        el('btn-mirror-b-to-a').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.mirrorTerrain(state.terrain.heights, state.edit2d.mirrorAngle, 'srcB', state.edit2d.mirrorAlsoFlip);
            applyHeightsToAll();
            setStatus('Mirrored B→A at ' + state.edit2d.mirrorAngle + '°.');
        });

        var mirrorAlsoFlipCb = el('mirror-also-flip');
        if (mirrorAlsoFlipCb) {
            mirrorAlsoFlipCb.addEventListener('change', function () {
                state.edit2d.mirrorAlsoFlip = mirrorAlsoFlipCb.checked;
            });
        }

        // Drag on 2D canvas to rotate mirror line; click to place measure points; click-to-stamp;
        // also handles texture alpha painting when texture tab is active
        var canvas2d = el('edit2d-canvas');
        if (canvas2d) {
            // Suppress middle-click scroll (used for Set Height height-pick in brush mode)
            canvas2d.addEventListener('auxclick', function (e) {
                if (e.button === 1) { e.preventDefault(); }
            });
            canvas2d.addEventListener('mousedown', function (e) {
                if (e.button === 1) { e.preventDefault(); }
            });

            canvas2d.addEventListener('pointerdown', function (e) {
                var rect = canvas2d.getBoundingClientRect();
                var px   = e.clientX - rect.left;
                var py   = e.clientY - rect.top;

                // Texture tab: alpha painting
                if (state.activeTab === 'texture' && e.button === 0) {
                    if (!state.terrain) return;
                    var gxT = (px / rect.width)  * TE.BLOCK;
                    var gyT = (py / rect.height) * TE.BLOCK;
                    state.texBrushGX   = gxT;
                    state.texBrushGY   = gyT;
                    state.texMouseDown = true;
                    state.lastBrushX   = gxT;
                    state.lastBrushY   = gyT;
                    pushUndo();
                    applyAlphaPaintAt(gxT, gyT);
                    drawTexCanvas();
                    canvas2d.setPointerCapture(e.pointerId);
                    return;
                }

                // Stamp mode has priority in both edit2d and imgedit tabs
                if (state.edit2d.stamp.img && e.button === 0 &&
                    (state.activeTab === 'edit2d' || state.activeTab === 'imgedit')) {
                    if (!state.terrain) return;
                    var st2 = state.edit2d.stamp;
                    pushUndo();
                    TE.applyStamp(state.terrain.heights,
                                  st2.imgData, st2.x, st2.y,
                                  st2.scale, st2.rotation || 0, st2.strength, st2.mode);
                    applyHeightsToAll();
                    setStatus('Stamp applied at (' + Math.round(st2.x) + ', ' + Math.round(st2.y) +
                              '), rot: ' + (st2.rotation || 0) + '\xb0.');
                    return;
                }

                // 2D Edit (image-editor) tab: brush paint, paste preview dragging, or selection start
                if (state.activeTab === 'imgedit') {
                    if (!state.terrain) return;
                    var gxI = (px / rect.width)  * TE.BLOCK;
                    var gyI = (py / rect.height) * TE.BLOCK;
                    var ieDown = state.imgEdit;

                    // Middle-click in brush mode + Set Height: pick height under cursor
                    if (e.button === 1 && ieDown.brush2dActive && ieDown.brush2dTool === 'setHeight') {
                        e.preventDefault();
                        var gxPick = Math.max(0, Math.min(TE.BLOCK - 1, Math.round(gxI)));
                        var gyPick = Math.max(0, Math.min(TE.BLOCK - 1, Math.round(gyI)));
                        var picked = state.terrain.heights[gxPick + gyPick * TE.BLOCK];
                        ieDown.brush2dTargetHt = picked;
                        var tgtInp = el('imgedit-brush-target-ht');
                        if (tgtInp) tgtInp.value = picked.toFixed(0);
                        setStatus('2D brush target height set to ' + picked.toFixed(2) + ' m');
                        return;
                    }

                    // Middle-click while paste preview is active: stamp at current position
                    if (e.button === 1 && ieDown.pastePreview) {
                        e.preventDefault();
                        stampPastePreview();
                        drawImgEditCanvas();
                        return;
                    }

                    // Right-click: cancel paste preview (and always clear selection)
                    if (e.button === 2) {
                        if (ieDown.pastePreview) {
                            ieDown.pastePreview      = null;
                            ieDown.pasteDragging     = false;
                            ieDown.pasteDragStart    = null;
                            ieDown.pasteScaleHandle  = null;
                            ieDown.pasteScaleDragStart = null;
                            var cv2dCancel = el('edit2d-canvas');
                            if (cv2dCancel) cv2dCancel.style.cursor = 'crosshair';
                            setStatus('Paste cancelled.');
                        }
                        // Always clear selection on right-click
                        ieDown.selection   = null;
                        ieDown.mask        = null;
                        ieDown.lassoPoints = [];
                        ieDown.ellipse     = null;
                        imgEditUpdateInfo();
                        drawImgEditCanvas();
                        return;
                    }

                    if (e.button !== 0) return;

                    // Brush paint mode: start a paint stroke
                    if (ieDown.brush2dActive) {
                        ieDown.brush2dPainting = true;
                        ieDown.brush2dGX = gxI;
                        ieDown.brush2dGY = gyI;
                        pushUndo();
                        applyBrush2d(gxI, gyI);
                        canvas2d.setPointerCapture(e.pointerId);
                        return;
                    }

                    // Paste preview: check scale handles first, then drag/commit
                    if (ieDown.pastePreview) {
                        var pp2 = ieDown.pastePreview;

                        // Scale handle hit test (screen-pixel coords)
                        var hitH = hitPasteHandle(px, py, pp2, rect.width, rect.height, TE.BLOCK);
                        if (hitH) {
                            // Compute anchor world position (opposite corner/edge stays fixed)
                            var ppAngle = (pp2.rotation || 0) * Math.PI / 180;
                            var ppcA = Math.cos(ppAngle), ppsA = Math.sin(ppAngle);
                            var ppcx = pp2.ox + pp2.w / 2, ppcy = pp2.oy + pp2.h / 2;
                            var alx  = -hitH.hlx, aly = -hitH.hly;  // anchor in ±1 normalised local
                            var aAncX = ppcx + alx * (pp2.w / 2) * ppcA - aly * (pp2.h / 2) * ppsA;
                            var aAncY = ppcy + alx * (pp2.w / 2) * ppsA + aly * (pp2.h / 2) * ppcA;
                            ieDown.pasteScaleHandle    = hitH;
                            ieDown.pasteScaleDragStart = {
                                anchorX: aAncX, anchorY: aAncY,
                                startW:  pp2.w,  startH:  pp2.h
                            };
                            canvas2d.style.cursor = HANDLE_CURSORS[hitH.name] || 'se-resize';
                            canvas2d.setPointerCapture(e.pointerId);
                            drawImgEditCanvas();
                            return;
                        }

                        if (gxI >= pp2.ox && gxI <= pp2.ox + pp2.w &&
                            gyI >= pp2.oy && gyI <= pp2.oy + pp2.h) {
                            // Click inside preview: start drag
                            ieDown.pasteDragging  = true;
                            ieDown.pasteDragStart = { mx: gxI, my: gyI, ox0: pp2.ox, oy0: pp2.oy };
                            canvas2d.setPointerCapture(e.pointerId);
                        } else {
                            // Click outside: commit, then start fresh selection
                            commitPastePreview();
                            ieDown.selecting   = true;
                            ieDown.dragStart   = { x: gxI, y: gyI };
                            ieDown.mask        = null;
                            ieDown.lassoPoints = [];
                            ieDown.ellipse     = null;
                            if (ieDown.selMode !== 'lasso' && ieDown.selMode !== 'ellipse') {
                                ieDown.selection = normalizeSelection(gxI, gyI, gxI, gyI);
                            } else {
                                ieDown.selection = null;
                            }
                            canvas2d.setPointerCapture(e.pointerId);
                        }
                        imgEditUpdateInfo();
                        drawImgEditCanvas();
                        return;
                    }

                    // Normal selection start
                    ieDown.selecting   = true;
                    ieDown.dragStart   = { x: gxI, y: gyI };
                    ieDown.mask        = null;
                    ieDown.ellipse     = null;

                    if (ieDown.selMode === 'lasso') {
                        ieDown.lassoPoints = [{ x: gxI, y: gyI }];
                        ieDown.selection   = null;
                    } else if (ieDown.selMode === 'ellipse') {
                        ieDown.lassoPoints = [];
                        ieDown.selection   = null;
                    } else {
                        ieDown.lassoPoints = [];
                        ieDown.selection   = normalizeSelection(gxI, gyI, gxI, gyI);
                    }

                    canvas2d.setPointerCapture(e.pointerId);
                    imgEditUpdateInfo();
                    drawImgEditCanvas();
                    return;
                }

                // Measure mode gets top priority in edit2d
                if (state.edit2d.measuring) {
                    var gx = px / rect.width  * TE.BLOCK;
                    var gy = py / rect.height * TE.BLOCK;
                    if (!state.edit2d.measureA) {
                        state.edit2d.measureA = { x: gx, y: gy };
                        state.edit2d.measureB = null;
                        setHTML('measure-result', 'Point A set. Click second point.');
                    } else {
                        state.edit2d.measureB = { x: gx, y: gy };
                        var dx = (gx - state.edit2d.measureA.x) * TE.SCALE;
                        var dy = (gy - state.edit2d.measureA.y) * TE.SCALE;
                        var dist = Math.sqrt(dx * dx + dy * dy);
                        var cells = Math.sqrt(
                            Math.pow(gx - state.edit2d.measureA.x, 2) +
                            Math.pow(gy - state.edit2d.measureA.y, 2)
                        );
                        setHTML('measure-result',
                            dist.toFixed(1) + ' m &nbsp;(' + cells.toFixed(1) + ' cells)');
                    }
                    if (state.activeTab === 'edit2d') draw2dCanvas();
                    return;
                }

                // Mirror-drag mode (only when mirror is enabled and no stamp active)
                if (state.edit2d.mirrorEnabled) {
                    state.edit2d.dragActive = true;
                    canvas2d.setPointerCapture(e.pointerId);
                }
            });

            canvas2d.addEventListener('pointermove', function (e) {
                var rect = canvas2d.getBoundingClientRect();
                var px   = e.clientX - rect.left;
                var py   = e.clientY - rect.top;

                // Texture tab: brush preview + painting
                if (state.activeTab === 'texture') {
                    var gxT = (px / rect.width)  * TE.BLOCK;
                    var gyT = (py / rect.height) * TE.BLOCK;
                    state.texBrushGX = gxT;
                    state.texBrushGY = gyT;
                    if (state.texMouseDown && state.terrain) {
                        var dxT = gxT - state.lastBrushX;
                        var dyT = gyT - state.lastBrushY;
                        if (dxT * dxT + dyT * dyT >= 0.25) {
                            applyAlphaPaintAt(gxT, gyT);
                            state.lastBrushX = gxT;
                            state.lastBrushY = gyT;
                        }
                    }
                    drawTexCanvas();
                    return;
                }

                // 2D Edit (image-editor) tab
                if (state.activeTab === 'imgedit') {
                    var gxI = (px / rect.width)  * TE.BLOCK;
                    var gyI = (py / rect.height) * TE.BLOCK;
                    var ieMove = state.imgEdit;

                    // Brush cursor tracking (always update position when in brush mode)
                    if (ieMove.brush2dActive) {
                        ieMove.brush2dGX = gxI;
                        ieMove.brush2dGY = gyI;
                        if (ieMove.brush2dPainting && state.terrain) {
                            applyBrush2d(gxI, gyI);
                        } else {
                            drawImgEditCanvas();
                        }
                        return;
                    }

                    // Paste preview scale drag
                    if (ieMove.pasteScaleHandle && ieMove.pastePreview && ieMove.pasteScaleDragStart) {
                        var ppS  = ieMove.pastePreview;
                        var sds  = ieMove.pasteScaleDragStart;
                        var hitS = ieMove.pasteScaleHandle;
                        var angS = (ppS.rotation || 0) * Math.PI / 180;
                        var cA   = Math.cos(angS), sA = Math.sin(angS);
                        // Vector from anchor to mouse in world (grid) coords, projected into local frame
                        var dxW  = gxI - sds.anchorX, dyW = gyI - sds.anchorY;
                        var lDX  = dxW * cA + dyW * sA;
                        var lDY  = -dxW * sA + dyW * cA;
                        // New dimensions (per-axis based on which handle is dragged)
                        var nW = hitS.hlx !== 0 ? Math.max(1, hitS.hlx * lDX) : sds.startW;
                        var nH = hitS.hly !== 0 ? Math.max(1, hitS.hly * lDY) : sds.startH;
                        // New centre in world coords
                        var nCX = sds.anchorX + (hitS.hlx * nW / 2) * cA - (hitS.hly * nH / 2) * sA;
                        var nCY = sds.anchorY + (hitS.hlx * nW / 2) * sA + (hitS.hly * nH / 2) * cA;
                        applyPasteScale(ppS, nW, nH, nCX - nW / 2, nCY - nH / 2);
                        drawImgEditCanvas();
                        return;
                    }

                    // Paste preview drag
                    if (ieMove.pasteDragging && ieMove.pastePreview && ieMove.pasteDragStart) {
                        var ddx = gxI - ieMove.pasteDragStart.mx;
                        var ddy = gyI - ieMove.pasteDragStart.my;
                        ieMove.pastePreview.ox = Math.round(ieMove.pasteDragStart.ox0 + ddx);
                        ieMove.pastePreview.oy = Math.round(ieMove.pasteDragStart.oy0 + ddy);
                        drawImgEditCanvas();
                        return;
                    }

                    // Update cursor for paste preview handle hover (no drag active)
                    if (ieMove.pastePreview && !ieMove.pasteDragging) {
                        var hoverH = hitPasteHandle(px, py, ieMove.pastePreview, rect.width, rect.height, TE.BLOCK);
                        if (hoverH) {
                            canvas2d.style.cursor = HANDLE_CURSORS[hoverH.name] || 'se-resize';
                        } else {
                            var inBodyX = gxI >= ieMove.pastePreview.ox && gxI <= ieMove.pastePreview.ox + ieMove.pastePreview.w;
                            var inBodyY = gyI >= ieMove.pastePreview.oy && gyI <= ieMove.pastePreview.oy + ieMove.pastePreview.h;
                            canvas2d.style.cursor = (inBodyX && inBodyY) ? 'move' : 'crosshair';
                        }
                    }

                    if (!ieMove.selecting || !ieMove.dragStart) return;

                    if (ieMove.selMode === 'lasso') {
                        var lastLP = ieMove.lassoPoints[ieMove.lassoPoints.length - 1];
                        var lddx = gxI - lastLP.x, lddy = gyI - lastLP.y;
                        if (lddx * lddx + lddy * lddy >= 0.25) {
                            ieMove.lassoPoints.push({ x: gxI, y: gyI });
                        }
                        // Update bounding box as selection
                        ieMove.selection = lassoBBox(ieMove.lassoPoints);
                        imgEditUpdateInfo();
                        drawImgEditCanvas();
                    } else if (ieMove.selMode === 'ellipse') {
                        var ecx = (ieMove.dragStart.x + gxI) / 2;
                        var ecy = (ieMove.dragStart.y + gyI) / 2;
                        var erx = Math.abs(gxI - ieMove.dragStart.x) / 2;
                        var ery = Math.abs(gyI - ieMove.dragStart.y) / 2;
                        if (ieMove.ellipseCircle) { var er = Math.max(erx, ery); erx = er; ery = er; }
                        ieMove.ellipse   = { cx: ecx, cy: ecy, rx: Math.max(0.5, erx), ry: Math.max(0.5, ery) };
                        ieMove.selection = ellipseBBox(ieMove.ellipse, ieMove.ellipseAngle);
                        imgEditUpdateInfo();
                        drawImgEditCanvas();
                    } else {
                        ieMove.selection = normalizeSelection(
                            ieMove.dragStart.x, ieMove.dragStart.y, gxI, gyI);
                        imgEditUpdateInfo();
                        drawImgEditCanvas();
                    }
                    return;
                }

                // Stamp follows the mouse (edit2d or imgedit)
                if (state.edit2d.stamp.img) {
                    var gx2 = Math.max(0, Math.min(TE.BLOCK, px / rect.width  * TE.BLOCK));
                    var gy2 = Math.max(0, Math.min(TE.BLOCK, py / rect.height * TE.BLOCK));
                    state.edit2d.stamp.x = gx2;
                    state.edit2d.stamp.y = gy2;
                    var sxEl = el('stamp-x'), syEl = el('stamp-y');
                    if (sxEl) sxEl.value = Math.round(gx2);
                    if (syEl) syEl.value = Math.round(gy2);
                    setHTML('val-stamp-x', Math.round(gx2));
                    setHTML('val-stamp-y', Math.round(gy2));
                    if (state.activeTab === 'edit2d') draw2dCanvas();
                    if (state.activeTab === 'imgedit') drawImgEditCanvas();
                    return;   // don't also do mirror drag
                }

                if (!state.edit2d.dragActive) return;
                var cx   = rect.width  / 2;
                var cy   = rect.height / 2;
                // atan2(x-delta, y-delta) gives angle from vertical (our convention)
                var angle = Math.atan2(px - cx, py - cy) * 180 / Math.PI;
                if (angle < 0)    angle += 180;
                if (angle >= 180) angle -= 180;
                setMirrorAngle(Math.round(angle));
            });

            canvas2d.addEventListener('pointerup', function () {
                // Texture tab: finish paint stroke
                if (state.activeTab === 'texture' && state.texMouseDown) {
                    state.texMouseDown = false;
                    drawTexCanvas();
                    renderTextureTab();
                    setStatus('Alpha layer ' + (state.texPaint.layer + 1) + ' painted.');
                    return;
                }
                // 2D Edit: finish brush paint, paste drag, or selection
                if (state.activeTab === 'imgedit') {
                    var ieUp = state.imgEdit;
                    // End brush paint stroke
                    if (ieUp.brush2dPainting) {
                        ieUp.brush2dPainting = false;
                        applyHeightsToAll();
                        setStatus('Brush paint stroke done.');
                        drawImgEditCanvas();
                        return;
                    }
                    if (ieUp.pasteDragging) {
                        ieUp.pasteDragging  = false;
                        ieUp.pasteDragStart = null;
                        drawImgEditCanvas();
                        return;
                    }
                    if (ieUp.pasteScaleHandle) {
                        ieUp.pasteScaleHandle    = null;
                        ieUp.pasteScaleDragStart = null;
                        drawImgEditCanvas();
                        return;
                    }
                    if (ieUp.selecting) {
                        ieUp.selecting  = false;
                        ieUp.dragStart  = null;
                        if (ieUp.selMode === 'lasso') {
                            if (ieUp.lassoPoints.length >= 3) {
                                ieUp.mask      = computeLassoMask(ieUp.lassoPoints);
                                ieUp.selection = lassoBBox(ieUp.lassoPoints);
                                if (ieUp.selection) {
                                    setStatus('Lasso: ' + (ieUp.selection.x1 - ieUp.selection.x0) +
                                              '\xd7' + (ieUp.selection.y1 - ieUp.selection.y0) +
                                              ' cells (bbox).');
                                }
                            } else {
                                ieUp.lassoPoints = [];
                                ieUp.selection   = null;
                                ieUp.mask        = null;
                                setStatus('Lasso too small — cleared.');
                            }
                        } else if (ieUp.selMode === 'ellipse') {
                            if (ieUp.ellipse) {
                                ieUp.mask      = computeEllipseMask(ieUp.ellipse, ieUp.ellipseAngle);
                                ieUp.selection = ellipseBBox(ieUp.ellipse, ieUp.ellipseAngle);
                                setStatus('Ellipse: rx=' + ieUp.ellipse.rx.toFixed(1) +
                                          ' ry=' + ieUp.ellipse.ry.toFixed(1) + '.');
                            }
                        } else {
                            if (ieUp.selection) {
                                var s = ieUp.selection;
                                setStatus('Selected ' + (s.x1 - s.x0) + '\xd7' + (s.y1 - s.y0) +
                                          ' at (' + s.x0 + ',' + s.y0 + ').');
                            }
                        }
                        imgEditUpdateInfo();
                        drawImgEditCanvas();
                    }
                    return;
                }
                state.edit2d.dragActive = false;
            });

            canvas2d.addEventListener('pointerleave', function () {
                if (state.activeTab === 'texture') {
                    state.texBrushGX = -1;
                    state.texBrushGY = -1;
                    if (state.texMouseDown) {
                        state.texMouseDown = false;
                        renderTextureTab();
                    }
                    drawTexCanvas();
                }
                if (state.activeTab === 'imgedit') {
                    var ie = state.imgEdit;
                    if (ie.brush2dActive) {
                        if (ie.brush2dPainting) {
                            ie.brush2dPainting = false;
                            applyHeightsToAll();
                        }
                        ie.brush2dGX = -1;
                        ie.brush2dGY = -1;
                        drawImgEditCanvas();
                    }
                }
            });

            // Wheel on edit2d-canvas: rotate paste preview when active
            canvas2d.addEventListener('wheel', function (e) {
                if (state.activeTab !== 'imgedit') return;
                var ieWh = state.imgEdit;
                if (!ieWh.pastePreview) return;
                e.preventDefault();
                var step = e.deltaY < 0 ? -5 : 5;
                ieWh.pastePreview.rotation = ((ieWh.pastePreview.rotation || 0) + step + 360) % 360;
                drawImgEditCanvas();
                setStatus('Paste rotation: ' + ieWh.pastePreview.rotation + '\xb0 \u2014 middle-click to stamp, right-click to cancel.');
            }, { passive: false });
        }

        // "Enable Mirror" toggle — in Mirror section, not in stamp-controls
        var btnMirrorToggle = el('btn-mirror-toggle');
        if (btnMirrorToggle) {
            btnMirrorToggle.addEventListener('click', function () {
                state.edit2d.mirrorEnabled = !state.edit2d.mirrorEnabled;
                btnMirrorToggle.classList.toggle('active', state.edit2d.mirrorEnabled);
                btnMirrorToggle.textContent = state.edit2d.mirrorEnabled
                    ? '🪞 Mirror Line: On' : '🪞 Mirror Line: Off';
                setStatus(state.edit2d.mirrorEnabled ? 'Mirror drag enabled.' : 'Mirror drag disabled.');
                if (state.activeTab === 'edit2d') draw2dCanvas();
            });
        }

        // Measure tool
        var btnMeasureToggle = el('btn-measure-toggle');
        if (btnMeasureToggle) {
            btnMeasureToggle.addEventListener('click', function () {
                state.edit2d.measuring = !state.edit2d.measuring;
                state.edit2d.measureA  = null;
                state.edit2d.measureB  = null;
                setHTML('measure-result', state.edit2d.measuring
                    ? 'Click point A on the map…' : '');
                // Activating measure clears stamp mode
                if (state.edit2d.measuring && state.edit2d.stamp.img) {
                    clearStampMode();
                }
                canvas2d.style.cursor = state.edit2d.measuring ? 'cell' : 'crosshair';
                btnMeasureToggle.classList.toggle('active', state.edit2d.measuring);
                if (state.activeTab === 'edit2d') draw2dCanvas();
            });
        }

        var btnMeasureClear = el('btn-measure-clear');
        if (btnMeasureClear) {
            btnMeasureClear.addEventListener('click', function () {
                state.edit2d.measuring = false;
                state.edit2d.measureA  = null;
                state.edit2d.measureB  = null;
                setHTML('measure-result', '');
                if (canvas2d) canvas2d.style.cursor = 'crosshair';
                if (btnMeasureToggle) btnMeasureToggle.classList.remove('active');
                if (state.activeTab === 'edit2d') draw2dCanvas();
            });
        }

        // Stamp wiring is now in wireImgEditTab (stamp controls live in the 2D Edit panel)
    }

    // -----------------------------------------------------------------------
    // 2D Edit (image-editor) tab wiring
    // -----------------------------------------------------------------------

    function wireImgEditTab() {
        var ie = state.imgEdit;
        var N  = TE.BLOCK;

        function requireTerrain() {
            if (!state.terrain) { setStatus('Load or create a terrain first.'); return false; }
            return true;
        }
        function requireSelection() {
            if (!ie.selection) { setStatus('Make a selection first (drag on the heightmap).'); return false; }
            return true;
        }

        // ── Selection tool mode buttons ────────────────────────────────────
        ['rect', 'ellipse', 'lasso'].forEach(function (mode) {
            var btn = el('btn-imgedit-mode-' + mode);
            if (!btn) return;
            btn.addEventListener('click', function () {
                ie.selMode     = mode;
                ie.selection   = null;
                ie.mask        = null;
                ie.ellipse     = null;
                ie.lassoPoints = [];
                ie.selecting   = false;
                ie.dragStart   = null;
                ['rect', 'ellipse', 'lasso'].forEach(function (m) {
                    var b = el('btn-imgedit-mode-' + m);
                    if (b) b.classList.toggle('active', m === mode);
                });
                var eRow = el('imgedit-ellipse-row');
                if (eRow) eRow.style.display = mode === 'ellipse' ? '' : 'none';
                imgEditUpdateInfo();
                drawImgEditCanvas();
                setStatus(mode.charAt(0).toUpperCase() + mode.slice(1) + ' selection mode.');
            });
        });

        // Circle-lock toggle
        var btnCircle = el('btn-imgedit-circle-lock');
        if (btnCircle) {
            btnCircle.addEventListener('click', function () {
                ie.ellipseCircle = !ie.ellipseCircle;
                btnCircle.classList.toggle('active', ie.ellipseCircle);
                setStatus('Circle lock ' + (ie.ellipseCircle ? 'ON' : 'OFF') + '.');
            });
        }

        // Ellipse rotation slider
        var ellAngleSlider = el('imgedit-ellipse-angle');
        if (ellAngleSlider) {
            ellAngleSlider.addEventListener('input', function () {
                ie.ellipseAngle = parseInt(ellAngleSlider.value) || 0;
                setHTML('val-imgedit-ellipse-angle', ie.ellipseAngle + '\xb0');
                if (ie.ellipse) {
                    ie.mask      = computeEllipseMask(ie.ellipse, ie.ellipseAngle);
                    ie.selection = ellipseBBox(ie.ellipse, ie.ellipseAngle);
                    imgEditUpdateInfo();
                    drawImgEditCanvas();
                }
            });
        }

        // ── Selection X / Y / W / H inputs ────────────────────────────────
        function bindSelInput(id, onChange) {
            var inp = el(id);
            if (!inp) return;
            inp.addEventListener('input', function () {
                if (!state.terrain) return;
                var v = parseInt(inp.value);
                if (isNaN(v)) return;
                onChange(v);
            });
        }

        bindSelInput('imgedit-sel-x', function (v) {
            if (!ie.selection) ie.selection = { x0: 0, y0: 0, x1: N, y1: N };
            var w = ie.selection.x1 - ie.selection.x0;
            ie.selection.x0 = Math.max(0, Math.min(N - 1, v));
            ie.selection.x1 = Math.min(N, ie.selection.x0 + Math.max(1, w));
            ie.mask = null; ie.ellipse = null;
            drawImgEditCanvas();
        });
        bindSelInput('imgedit-sel-y', function (v) {
            if (!ie.selection) ie.selection = { x0: 0, y0: 0, x1: N, y1: N };
            var h = ie.selection.y1 - ie.selection.y0;
            ie.selection.y0 = Math.max(0, Math.min(N - 1, v));
            ie.selection.y1 = Math.min(N, ie.selection.y0 + Math.max(1, h));
            ie.mask = null; ie.ellipse = null;
            drawImgEditCanvas();
        });
        bindSelInput('imgedit-sel-w', function (v) {
            if (!ie.selection) ie.selection = { x0: 0, y0: 0, x1: N, y1: N };
            ie.selection.x1 = Math.min(N, ie.selection.x0 + Math.max(1, v));
            ie.mask = null; ie.ellipse = null;
            drawImgEditCanvas();
        });
        bindSelInput('imgedit-sel-h', function (v) {
            if (!ie.selection) ie.selection = { x0: 0, y0: 0, x1: N, y1: N };
            ie.selection.y1 = Math.min(N, ie.selection.y0 + Math.max(1, v));
            ie.mask = null; ie.ellipse = null;
            drawImgEditCanvas();
        });

        // ── Selection ─────────────────────────────────────────────────────
        el('btn-imgedit-select-all').addEventListener('click', function () {
            if (!requireTerrain()) return;
            ie.selMode   = 'rect';
            ie.selection = { x0: 0, y0: 0, x1: N, y1: N };
            ie.mask      = null;
            ie.ellipse   = null;
            // Sync mode buttons
            ['rect', 'ellipse', 'lasso'].forEach(function (m) {
                var b = el('btn-imgedit-mode-' + m);
                if (b) b.classList.toggle('active', m === 'rect');
            });
            var eRow = el('imgedit-ellipse-row');
            if (eRow) eRow.style.display = 'none';
            imgEditUpdateInfo();
            drawImgEditCanvas();
            setStatus('Selected entire heightmap.');
        });

        el('btn-imgedit-deselect').addEventListener('click', function () {
            ie.selection   = null;
            ie.mask        = null;
            ie.ellipse     = null;
            ie.lassoPoints = [];
            imgEditUpdateInfo();
            drawImgEditCanvas();
            setStatus('Selection cleared.');
        });

        var btnInvert = el('btn-imgedit-invert');
        if (btnInvert) {
            btnInvert.addEventListener('click', function () {
                if (!requireTerrain()) return;
                invertSelection();
                imgEditUpdateInfo();
                drawImgEditCanvas();
                setStatus('Selection inverted.');
            });
        }

        // ── 2D Brush Paint ─────────────────────────────────────────────────
        var btnBrushToggle = el('btn-imgedit-brush-toggle');
        var brushControls  = el('imgedit-brush-controls');
        var canvas2dRef    = el('edit2d-canvas');

        if (btnBrushToggle) {
            btnBrushToggle.addEventListener('click', function () {
                ie.brush2dActive = !ie.brush2dActive;
                btnBrushToggle.classList.toggle('active', ie.brush2dActive);
                btnBrushToggle.textContent = '\uD83D\uDD8C\uFE0F Brush Paint: ' +
                    (ie.brush2dActive ? 'On' : 'Off');
                if (brushControls) brushControls.style.display = ie.brush2dActive ? '' : 'none';
                if (canvas2dRef) canvas2dRef.style.cursor = ie.brush2dActive ? 'none' : 'crosshair';
                if (!ie.brush2dActive) {
                    ie.brush2dPainting = false;
                    ie.brush2dGX = -1;
                    ie.brush2dGY = -1;
                }
                drawImgEditCanvas();
                setStatus('2D Brush Paint ' + (ie.brush2dActive ? 'enabled.' : 'disabled.'));
            });
        }

        // Brush tool selector buttons
        var ieBrushBtns = document.querySelectorAll('.ie-brush-btn');
        ieBrushBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                ie.brush2dTool = btn.getAttribute('data-brushtool');
                ieBrushBtns.forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                var stRow = el('imgedit-brush-setheight-row');
                if (stRow) stRow.style.display = (ie.brush2dTool === 'setHeight') ? '' : 'none';
                setStatus('2D Brush: ' + ie.brush2dTool + ' tool.');
            });
        });

        // Brush radius slider
        var iBrushRad = el('imgedit-brush-radius');
        if (iBrushRad) {
            iBrushRad.addEventListener('input', function () {
                ie.brush2dRadius = parseFloat(iBrushRad.value) || 10;
                setHTML('val-imgedit-brush-radius', Math.round(ie.brush2dRadius));
                if (ie.brush2dActive) drawImgEditCanvas();
            });
        }

        // Brush strength slider
        var iBrushStr = el('imgedit-brush-strength');
        if (iBrushStr) {
            iBrushStr.addEventListener('input', function () {
                ie.brush2dStrength = parseFloat(iBrushStr.value) || 5;
                setHTML('val-imgedit-brush-strength', ie.brush2dStrength.toFixed(1));
            });
        }

        // Brush falloff
        var iBrushFo = el('imgedit-brush-falloff');
        if (iBrushFo) {
            iBrushFo.addEventListener('change', function () {
                ie.brush2dFalloff = iBrushFo.value;
            });
        }

        // Brush symmetry
        var iBrushSym = el('imgedit-brush-symmetry');
        if (iBrushSym) {
            iBrushSym.addEventListener('change', function () {
                ie.brush2dSymmetry = iBrushSym.value;
            });
        }

        // Brush set-height target
        var iBrushTgt = el('imgedit-brush-target-ht');
        if (iBrushTgt) {
            iBrushTgt.addEventListener('change', function () {
                ie.brush2dTargetHt = parseFloat(iBrushTgt.value) || 100;
            });
        }


        // Sync texture layers toggle
        var syncTexCb = el('imgedit-sync-textures');
        if (syncTexCb) {
            syncTexCb.addEventListener('change', function () {
                ie.syncTextures = syncTexCb.checked;
            });
        }

        el('btn-imgedit-copy').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            copySelectionToClipboard();
            imgEditUpdateInfo();
            setStatus('Copied ' + ie.clipboard.w + '\xd7' + ie.clipboard.h + ' cells to clipboard.');
        });

        el('btn-imgedit-cut').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            copySelectionToClipboard();
            var lo = Infinity;
            forEachSelected(function (i) {
                if (state.terrain.heights[i] < lo) lo = state.terrain.heights[i];
            });
            if (!isFinite(lo)) lo = 0;
            pushUndo();
            forEachSelected(function (i) { state.terrain.heights[i] = lo; });
            // Clear texture alpha layers in the selection if sync is enabled
            if (ie.syncTextures && state.terrain.materialAlphaMaps) {
                state.terrain.materialAlphaMaps.forEach(function (aMap) {
                    if (!aMap) return;
                    forEachSelected(function (i) { aMap[i] = 0; });
                });
            }
            applyHeightsToAll();
            imgEditUpdateInfo();
            setStatus('Cut ' + ie.clipboard.w + '\xd7' + ie.clipboard.h +
                      ' cells; flattened to ' + lo.toFixed(1) + 'm.');
        });

        // Paste creates a floating preview that the user can drag before committing
        el('btn-imgedit-paste').addEventListener('click', function () {
            if (!requireTerrain()) return;
            loadClipboardFromStorage();
            if (!ie.clipboard) { setStatus('Clipboard is empty — copy or cut something first.'); return; }
            var ox = ie.selection ? ie.selection.x0 : 0;
            var oy = ie.selection ? ie.selection.y0 : 0;
            ie.pastePreview = {
                data          : new Float32Array(ie.clipboard.data),
                origData      : ie.clipboard.data,
                w             : ie.clipboard.w,
                h             : ie.clipboard.h,
                origW         : ie.clipboard.w,
                origH         : ie.clipboard.h,
                ox            : ox,
                oy            : oy,
                mask          : ie.clipboard.mask ? new Uint8Array(ie.clipboard.mask) : null,
                origMask      : ie.clipboard.mask || null,
                rotation      : 0,
                alphaMaps     : ie.clipboard.alphaMaps
                    ? ie.clipboard.alphaMaps.map(function (a) { return a ? new Uint8Array(a) : null; })
                    : null,
                origAlphaMaps : ie.clipboard.alphaMaps || null
            };
            var cv2d = el('edit2d-canvas');
            if (cv2d) cv2d.style.cursor = 'move';
            imgEditUpdateInfo();
            drawImgEditCanvas();
            setStatus('Paste preview \u2014 drag to position \u00b7 scroll to rotate \u00b7 middle-click to stamp \u00b7 right-click to cancel.');
        });

        el('btn-imgedit-paste-commit').addEventListener('click', function () {
            commitPastePreview();
        });

        el('btn-imgedit-paste-cancel').addEventListener('click', function () {
            ie.pastePreview      = null;
            ie.pasteDragging     = false;
            ie.pasteDragStart    = null;
            ie.pasteScaleHandle  = null;
            ie.pasteScaleDragStart = null;
            var cv2d = el('edit2d-canvas');
            if (cv2d) cv2d.style.cursor = 'crosshair';
            imgEditUpdateInfo();
            drawImgEditCanvas();
            setStatus('Paste cancelled.');
        });

        el('btn-imgedit-delete').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var lo = Infinity;
            forEachSelected(function (i) {
                if (state.terrain.heights[i] < lo) lo = state.terrain.heights[i];
            });
            if (!isFinite(lo)) lo = 0;
            pushUndo();
            forEachSelected(function (i) { state.terrain.heights[i] = lo; });
            // Clear texture alpha layers in the selection if sync is enabled
            if (ie.syncTextures && state.terrain.materialAlphaMaps) {
                state.terrain.materialAlphaMaps.forEach(function (aMap) {
                    if (!aMap) return;
                    forEachSelected(function (i) { aMap[i] = 0; });
                });
            }
            applyHeightsToAll();
            setStatus('Selection flattened to ' + lo.toFixed(1) + 'm.');
        });

        // ── Fill / Adjust ──────────────────────────────────────────────────
        var fillInput  = el('imgedit-fill-height');
        var deltaInput = el('imgedit-delta');
        if (fillInput)  fillInput.addEventListener('change',  function () { ie.fillHeight = parseFloat(fillInput.value)  || 0; });
        if (deltaInput) deltaInput.addEventListener('change', function () { ie.delta      = parseFloat(deltaInput.value) || 0; });

        el('btn-imgedit-fill').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var v = parseFloat(fillInput && fillInput.value) || 0;
            ie.fillHeight = v;
            pushUndo();
            forEachSelected(function (i) { state.terrain.heights[i] = v; });
            applyHeightsToAll();
            setStatus('Filled selection with ' + v.toFixed(1) + 'm.');
        });

        el('btn-imgedit-raise').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var d = parseFloat(deltaInput && deltaInput.value) || 0;
            ie.delta = d;
            pushUndo();
            forEachSelected(function (i) { state.terrain.heights[i] += d; });
            applyHeightsToAll();
            setStatus('Raised selection by ' + d.toFixed(1) + 'm.');
        });

        el('btn-imgedit-lower').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var d = parseFloat(deltaInput && deltaInput.value) || 0;
            ie.delta = d;
            pushUndo();
            forEachSelected(function (i) { state.terrain.heights[i] -= d; });
            applyHeightsToAll();
            setStatus('Lowered selection by ' + d.toFixed(1) + 'm.');
        });

        el('btn-imgedit-smooth').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var sel = ie.selection;
            var src = new Float32Array(state.terrain.heights);
            pushUndo();
            forEachSelected(function (idx, x, y) {
                var sum = 0, cnt = 0;
                for (var oy = -1; oy <= 1; oy++) {
                    var yy = y + oy;
                    if (yy < 0 || yy >= N) continue;
                    for (var ox = -1; ox <= 1; ox++) {
                        var xx = x + ox;
                        if (xx < 0 || xx >= N) continue;
                        sum += src[xx + yy * N]; cnt++;
                    }
                }
                state.terrain.heights[idx] = sum / cnt;
            });
            applyHeightsToAll();
            setStatus('Smoothed selection (3\xd73 box blur).');
        });

        // ── Transform Selection ────────────────────────────────────────────
        el('btn-imgedit-flip-h').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var sel = ie.selection;
            var w = sel.x1 - sel.x0, h = sel.y1 - sel.y0;
            pushUndo();
            for (var y = 0; y < h; y++) {
                var rowOff = (sel.y0 + y) * N + sel.x0;
                for (var x = 0; x < Math.floor(w / 2); x++) {
                    var a = rowOff + x, b = rowOff + (w - 1 - x);
                    var t = state.terrain.heights[a];
                    state.terrain.heights[a] = state.terrain.heights[b];
                    state.terrain.heights[b] = t;
                }
            }
            applyHeightsToAll();
            setStatus('Flipped selection horizontally.');
        });

        el('btn-imgedit-flip-v').addEventListener('click', function () {
            if (!requireTerrain() || !requireSelection()) return;
            var sel = ie.selection;
            var w = sel.x1 - sel.x0, h = sel.y1 - sel.y0;
            pushUndo();
            for (var y = 0; y < Math.floor(h / 2); y++) {
                var rowA = (sel.y0 + y) * N + sel.x0;
                var rowB = (sel.y0 + (h - 1 - y)) * N + sel.x0;
                for (var x = 0; x < w; x++) {
                    var t = state.terrain.heights[rowA + x];
                    state.terrain.heights[rowA + x] = state.terrain.heights[rowB + x];
                    state.terrain.heights[rowB + x] = t;
                }
            }
            applyHeightsToAll();
            setStatus('Flipped selection vertically.');
        });

        // ── Stamp from PNG (moved here from Mirror Mode) ───────────────────
        var stampInput = el('stamp-file-input');
        var btnLoadStamp = el('btn-load-stamp');
        if (btnLoadStamp) {
            btnLoadStamp.addEventListener('click', function () {
                if (stampInput) stampInput.click();
            });
        }

        if (stampInput) {
            stampInput.addEventListener('change', function (e) {
                var file = e.target.files[0];
                if (!file) return;
                var url = URL.createObjectURL(file);
                var img = new Image();
                img.onload = function () {
                    var tmp    = document.createElement('canvas');
                    tmp.width  = img.naturalWidth;
                    tmp.height = img.naturalHeight;
                    tmp.getContext('2d').drawImage(img, 0, 0);
                    state.edit2d.stamp.img     = img;
                    state.edit2d.stamp.imgData = tmp.getContext('2d').getImageData(
                        0, 0, img.naturalWidth, img.naturalHeight
                    );
                    // Disable mirror drag while stamp is active
                    state.edit2d.mirrorEnabled = false;
                    var bmt = el('btn-mirror-toggle');
                    if (bmt) { bmt.classList.remove('active'); bmt.textContent = '🪞 Mirror Line: Off'; }
                    // Clear measure mode
                    if (state.edit2d.measuring) {
                        state.edit2d.measuring = false;
                        state.edit2d.measureA  = null;
                        state.edit2d.measureB  = null;
                        setHTML('measure-result', '');
                        var bmtog = el('btn-measure-toggle');
                        if (bmtog) bmtog.classList.remove('active');
                    }
                    var cv2d = el('edit2d-canvas');
                    if (cv2d) cv2d.style.cursor = 'none';
                    var sc = el('stamp-controls');
                    if (sc) sc.style.display = '';
                    if (state.activeTab === 'imgedit') drawImgEditCanvas();
                    setStatus('Stamp loaded: ' + file.name + ' — click the map to stamp.');
                };
                img.onerror = function () { alert('Failed to load stamp image.'); };
                img.src = url;
                stampInput.value = '';
            });
        }

        function bindStampSlider(id, valId, onchange) {
            var s = el(id), v = el(valId);
            if (!s) return;
            s.addEventListener('input', function () {
                onchange(parseFloat(s.value), v);
                if (state.activeTab === 'edit2d') draw2dCanvas();
                if (state.activeTab === 'imgedit') drawImgEditCanvas();
            });
        }

        bindStampSlider('stamp-x', 'val-stamp-x', function (val, v) {
            state.edit2d.stamp.x = val;
            if (v) v.textContent = Math.round(val);
        });
        bindStampSlider('stamp-y', 'val-stamp-y', function (val, v) {
            state.edit2d.stamp.y = val;
            if (v) v.textContent = Math.round(val);
        });
        bindStampSlider('stamp-scale', 'val-stamp-scale', function (val, v) {
            state.edit2d.stamp.scale = val / 100;
            if (v) v.textContent = (val / 100).toFixed(2) + '\xd7';
        });
        bindStampSlider('stamp-rotation', 'val-stamp-rotation', function (val, v) {
            state.edit2d.stamp.rotation = val;
            if (v) v.textContent = Math.round(val) + '\xb0';
        });
        bindStampSlider('stamp-strength', 'val-stamp-strength', function (val, v) {
            state.edit2d.stamp.strength = val / 100;
            if (v) v.textContent = (val / 100).toFixed(2);
        });

        var stampModeSel = el('stamp-mode');
        if (stampModeSel) {
            stampModeSel.addEventListener('change', function () {
                state.edit2d.stamp.mode = stampModeSel.value;
            });
        }

        var btnStampApply = el('btn-stamp-apply');
        if (btnStampApply) {
            btnStampApply.addEventListener('click', function () {
                if (!state.terrain) return;
                var st = state.edit2d.stamp;
                if (!st.imgData) { alert('Load a PNG stamp image first.'); return; }
                pushUndo();
                TE.applyStamp(state.terrain.heights,
                              st.imgData, st.x, st.y, st.scale, st.rotation || 0, st.strength, st.mode);
                applyHeightsToAll();
                setStatus('Stamp applied at (' + Math.round(st.x) + ', ' + Math.round(st.y) +
                          '), rotation: ' + (st.rotation || 0) + '\xb0, mode: ' + st.mode + '.');
            });
        }

        var btnStampClear = el('btn-stamp-clear');
        if (btnStampClear) {
            btnStampClear.addEventListener('click', function () {
                clearStampMode();
                if (state.activeTab === 'imgedit') drawImgEditCanvas();
                if (state.activeTab === 'edit2d')  draw2dCanvas();
                setStatus('Stamp cleared.');
            });
        }

        // Initialise info readouts
        imgEditUpdateInfo();
    }

    function wireNoiseTab() {
        var np = state.noiseParams;

        function bindNoiseSlider(id, valId, toFixed, key, scale) {
            var s = el(id), v = el(valId);
            if (!s) return;
            s.addEventListener('input', function () {
                var val = parseFloat(s.value) * (scale || 1);
                np[key] = val;
                if (v) v.textContent = val.toFixed(toFixed);
            });
        }

        bindNoiseSlider('noise-scale',       'val-nscale',       4, 'scale', 0.001);
        bindNoiseSlider('noise-octaves',     'val-noctaves',     0, 'octaves', 1);
        bindNoiseSlider('noise-persistence', 'val-npersistence', 2, 'persistence', 0.01);
        bindNoiseSlider('noise-lacunarity',  'val-nlacunarity',  2, 'lacunarity', 0.1);
        bindNoiseSlider('noise-warp',        'val-nwarp',        1, 'warpScale', 0.1);
        bindNoiseSlider('noise-seed',        'val-nseed',        0, 'seed', 1);
        bindNoiseSlider('noise-min-h',       'val-nminh',        0, 'minHeight', 1);
        bindNoiseSlider('noise-max-h',       'val-nmaxh',        0, 'maxHeight', 1);

        var typeSel = el('noise-type');
        if (typeSel) {
            typeSel.addEventListener('change', function () { np.type = typeSel.value; });
        }
        var opSel = el('noise-op');
        if (opSel) {
            opSel.addEventListener('change', function () { np.operation = opSel.value; });
        }

        el('btn-noise-preview').addEventListener('click', function () {
            if (!state.terrain) { alert('Load or create a terrain first.'); return; }
            drawNoisePreview();
        });

        el('btn-noise-apply').addEventListener('click', function () {
            if (!state.terrain) { alert('Load or create a terrain first.'); return; }
            pushUndo();
            var params = Object.assign({}, np);
            params.existingHeights = state.terrain.heights;
            var result = TE.generateNoise(params);
            state.terrain.heights.set(result);
            applyHeightsToAll();
            setStatus('Noise applied (' + np.type + ').');
        });

        // Water Erosion
        (function () {
            var dropletsSlider   = el('erosion-droplets');
            var erodibilitySlider = el('erosion-erodibility');
            var depositSlider    = el('erosion-deposit');
            var lifetimeSlider   = el('erosion-lifetime');
            var dropletsVal      = el('val-erosion-droplets');
            var erodibilityVal   = el('val-erosion-erodibility');
            var depositVal       = el('val-erosion-deposit');
            var lifetimeVal      = el('val-erosion-lifetime');

            if (dropletsSlider) dropletsSlider.addEventListener('input', function () {
                var v = parseInt(dropletsSlider.value);
                if (dropletsVal) dropletsVal.textContent = (v / 1000).toFixed(0) + 'k';
            });
            if (erodibilitySlider) erodibilitySlider.addEventListener('input', function () {
                if (erodibilityVal) erodibilityVal.textContent = erodibilitySlider.value;
            });
            if (depositSlider) depositSlider.addEventListener('input', function () {
                if (depositVal) depositVal.textContent = depositSlider.value;
            });
            if (lifetimeSlider) lifetimeSlider.addEventListener('input', function () {
                if (lifetimeVal) lifetimeVal.textContent = lifetimeSlider.value;
            });

            var btn = el('btn-water-erosion');
            if (btn) btn.addEventListener('click', function () {
                if (!state.terrain) return;
                pushUndo();
                var droplets    = dropletsSlider   ? parseInt(dropletsSlider.value)    : 50000;
                var erodibility = erodibilitySlider ? parseInt(erodibilitySlider.value) : 5;
                var deposit     = depositSlider     ? parseInt(depositSlider.value)     : 5;
                var lifetime    = lifetimeSlider    ? parseInt(lifetimeSlider.value)    : 30;
                TE.waterErosion(state.terrain.heights, {
                    numDroplets    : droplets,
                    erodeSpeed     : erodibility * 0.02,
                    depositSpeed   : deposit * 0.02,
                    maxLifetime    : lifetime
                });
                applyHeightsToAll();
                setStatus('Water erosion applied (' + (droplets / 1000).toFixed(0) + 'k droplets).');
            });
        }());
    }

    // -----------------------------------------------------------------------
    // Texture tab
    // -----------------------------------------------------------------------

    /**
     * Render (or re-render) the texture layer list in the texture tab panel.
     * Called each time the tab is activated so it always reflects current data.
     */
    function renderTextureTab() {
        var list = el('texture-layer-list');
        if (!list) return;

        // Keep existing upload inputs if they exist (avoid orphaning file-input refs)
        // Full rebuild each time; re-wiring is cheap at 8 layers.
        list.innerHTML = '';

        var N2 = TE.BLOCK;
        var names    = (state.terrain && state.terrain.materialFileNames) || [];
        var alphaMaps = (state.terrain && state.terrain.materialAlphaMaps) || [];
        var activePaintLayer = state.texPaint ? state.texPaint.layer : 0;

        for (var k = 0; k < TE.MAT_GROUPS; k++) {
            var name    = names[k] || '';
            var alphaMap = alphaMaps[k] || null;
            var isWarn  = (k >= 6);
            var isActive = (k === activePaintLayer);
            // Slot k requires slot k-1 to have a texture name before uploading
            var prevHasTex = (k === 0) || !!(names[k - 1] && names[k - 1].length > 0);

            var block = document.createElement('div');
            block.style.cssText = 'border:1px solid ' +
                (isActive ? '#4a9eff' : (isWarn ? '#6a3010' : '#303038')) +
                ';border-radius:4px;padding:6px 8px;margin-bottom:8px;background:#22222a;cursor:pointer;' +
                (isActive ? 'box-shadow:0 0 4px #4a9eff44;' : '');

            // Header row: slot label + material name
            var hdr = document.createElement('div');
            hdr.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';

            var slotLbl = document.createElement('span');
            slotLbl.style.cssText = 'font-size:11px;font-weight:700;color:' +
                (isActive ? '#7dcfff' : (isWarn ? '#e07030' : '#4a9eff')) + ';min-width:46px;';
            slotLbl.textContent = 'Slot ' + (k + 1) + (isActive ? ' ✏' : '') + (isWarn ? ' ⚠' : '');

            var nameLbl = document.createElement('span');
            nameLbl.style.cssText = 'font-size:11px;color:' +
                (name ? '#adf' : '#555') + ';flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nameLbl.title = name || '(empty — no texture assigned)';
            nameLbl.textContent = name || '(empty)';

            hdr.appendChild(slotLbl);
            hdr.appendChild(nameLbl);
            block.appendChild(hdr);

            if (isWarn) {
                var warnTxt = document.createElement('div');
                warnTxt.style.cssText = 'font-size:10px;color:#e07030;margin-bottom:4px;';
                warnTxt.textContent = 'Avoid this slot if possible — may be unstable in TGE/T2.';
                block.appendChild(warnTxt);
            }

            // Alpha map canvas preview
            var cvs = document.createElement('canvas');
            cvs.width  = N2;
            cvs.height = N2;
            cvs.style.cssText = 'display:block;width:100%;border:1px solid #363640;' +
                'image-rendering:pixelated;background:#111;margin-bottom:6px;';

            if (alphaMap) {
                var ctx2  = cvs.getContext('2d');
                var idata = ctx2.createImageData(N2, N2);
                for (var i = 0; i < N2 * N2; i++) {
                    var v2 = alphaMap[i];
                    idata.data[i * 4]     = v2;
                    idata.data[i * 4 + 1] = v2;
                    idata.data[i * 4 + 2] = v2;
                    idata.data[i * 4 + 3] = 255;
                }
                ctx2.putImageData(idata, 0, 0);
            } else {
                var ctx2 = cvs.getContext('2d');
                ctx2.fillStyle = '#1a1a22';
                ctx2.fillRect(0, 0, N2, N2);
                ctx2.fillStyle = '#444';
                ctx2.font = 'bold 12px monospace';
                ctx2.textAlign = 'center';
                ctx2.textBaseline = 'middle';
                ctx2.fillText('(no alpha map)', N2 / 2, N2 / 2);
            }
            block.appendChild(cvs);

            // Buttons: Download + Upload
            var btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px;';

            // Download button
            var dlBtn = document.createElement('button');
            dlBtn.className = 'btn';
            dlBtn.style.cssText = 'flex:1;font-size:11px;padding:4px 0;';
            dlBtn.textContent = '↓ Download';
            dlBtn.disabled = !alphaMap;
            dlBtn.title = alphaMap ? 'Download alpha map as PNG' : 'No alpha map to download';
            (function (kk, am, nm) {
                dlBtn.addEventListener('click', function () {
                    if (!am) return;
                    var tmpC = document.createElement('canvas');
                    tmpC.width = N2; tmpC.height = N2;
                    var c2 = tmpC.getContext('2d');
                    var id = c2.createImageData(N2, N2);
                    for (var ii = 0; ii < N2 * N2; ii++) {
                        id.data[ii * 4]     = am[ii];
                        id.data[ii * 4 + 1] = am[ii];
                        id.data[ii * 4 + 2] = am[ii];
                        id.data[ii * 4 + 3] = 255;
                    }
                    c2.putImageData(id, 0, 0);
                    tmpC.toBlob(function (blob) {
                        var a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = 'alpha_layer_' + (kk + 1) +
                            (nm ? '_' + nm.replace(/[^a-z0-9]/gi, '_') : '') + '.png';
                        a.click();
                    });
                });
            }(k, alphaMap, name));

            // Upload file input (hidden)
            var upInput = document.createElement('input');
            upInput.type = 'file';
            upInput.accept = 'image/png';
            upInput.style.display = 'none';

            // Upload button
            var upBtn = document.createElement('button');
            upBtn.className = 'btn btn-accent';
            upBtn.style.cssText = 'flex:1;font-size:11px;padding:4px 0;';
            upBtn.textContent = '↑ Upload';
            upBtn.disabled = !prevHasTex;
            upBtn.title = prevHasTex
                ? 'Upload a 256\xd7256 PNG to replace this alpha layer'
                : 'Set a texture in slot ' + k + ' before using this slot';
            (function (kk, ub, ui) {
                ub.addEventListener('click', function () { ui.click(); });
                ui.addEventListener('change', function (e) {
                    var f = e.target.files[0];
                    if (!f) return;
                    var ourl = URL.createObjectURL(f);
                    var im = new Image();
                    im.onload = function () {
                        URL.revokeObjectURL(ourl);
                        if (im.naturalWidth !== 256 || im.naturalHeight !== 256) {
                            alert('Alpha map PNG must be exactly 256\xd7256 pixels.\n' +
                                  'This image is ' + im.naturalWidth + '\xd7' + im.naturalHeight + '.');
                            return;
                        }
                        var tc = document.createElement('canvas');
                        tc.width = 256; tc.height = 256;
                        tc.getContext('2d').drawImage(im, 0, 0);
                        var id2 = tc.getContext('2d').getImageData(0, 0, 256, 256);
                        var newAM = new Uint8Array(256 * 256);
                        for (var ii2 = 0; ii2 < 256 * 256; ii2++) {
                            newAM[ii2] = Math.round(
                                (id2.data[ii2 * 4] + id2.data[ii2 * 4 + 1] + id2.data[ii2 * 4 + 2]) / 3
                            );
                        }
                        if (!state.terrain.materialAlphaMaps) {
                            state.terrain.materialAlphaMaps = new Array(TE.MAT_GROUPS).fill(null);
                        }
                        state.terrain.materialAlphaMaps[kk] = newAM;
                        state.dirty = true;
                        setStatus('Alpha layer ' + (kk + 1) + ' updated.');
                        renderTextureTab();
                        if (state.activeTab === 'texture') drawTexCanvas();
                    };
                    im.onerror = function () {
                        URL.revokeObjectURL(ourl);
                        alert('Failed to load PNG.');
                    };
                    im.src = ourl;
                    ui.value = '';
                });
            }(k, upBtn, upInput));

            btnRow.appendChild(dlBtn);
            btnRow.appendChild(upBtn);
            btnRow.appendChild(upInput);
            block.appendChild(btnRow);
            // Clicking anywhere on the slot block selects it as the active paint layer
            (function (kk) {
                block.addEventListener('click', function (e) {
                    // Don't steal clicks intended for buttons/inputs inside the block
                    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
                    if (state.texPaint.layer === kk) return;
                    state.texPaint.layer = kk;
                    var layerSel2 = el('tex-paint-layer');
                    if (layerSel2) layerSel2.value = String(kk);
                    renderTextureTab();
                    if (state.activeTab === 'texture') drawTexCanvas();
                    setStatus('Active paint layer set to Slot ' + (kk + 1) + '.');
                });
            }(k));

            list.appendChild(block);
        }
    }

    function wireTextureTab() {
        // Layer selector — update active paint layer and refresh list highlight
        var layerSel = el('tex-paint-layer');
        if (layerSel) {
            layerSel.addEventListener('change', function () {
                state.texPaint.layer = parseInt(layerSel.value);
                if (state.activeTab === 'texture') {
                    renderTextureTab();
                    drawTexCanvas();
                }
            });
        }

        // Paint/erase mode
        var modeSel = el('tex-paint-mode');
        if (modeSel) {
            modeSel.addEventListener('change', function () {
                state.texPaint.mode = modeSel.value;
            });
        }

        // Alpha paint brush sliders
        bindSlider('tex-radius', 'val-tex-radius', 0, function (v) {
            state.texPaint.radius = v;
        });
        bindSlider('tex-strength', 'val-tex-strength', 0, function (v) {
            state.texPaint.strength = v;
        });

        var texFalloff = el('tex-falloff');
        if (texFalloff) {
            texFalloff.addEventListener('change', function () {
                state.texPaint.falloff = texFalloff.value;
            });
        }
    }

    function wireDragDrop() {
        var canvas = el('render-canvas');
        canvas.addEventListener('dragover',  function (e) { e.preventDefault(); });
        canvas.addEventListener('drop', function (e) {
            e.preventDefault();
            var file = e.dataTransfer.files[0];
            if (file && file.name.toLowerCase().endsWith('.ter')) importTer(file);
        });
        document.body.addEventListener('dragover',  function (e) { e.preventDefault(); });
        document.body.addEventListener('drop', function (e) {
            e.preventDefault();
            var file = e.dataTransfer.files[0];
            if (file && file.name.toLowerCase().endsWith('.ter')) importTer(file);
        });
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    window.addEventListener('load', function () {
        // Init 3D
        var canvas = el('render-canvas');
        TE.initScene(canvas);

        // Create blank starting terrain
        state.terrain = TE.createEmptyTerrain();
        TE.createTerrainMesh(state.terrain.heights);
        TE.createBrushCursor();
        TE.setGridVisible(false);

        // Wire all UI
        wireUI();
        wireDragDrop();

        // Set initial UI state
        switchTab('view');
        selectTool('raise');
        updateStats();
        updateUndoButtons();
        updateMaterialList();
        initRemapFromTerrain();
        refreshPreviewCanvas();

        // Start in fly mode by default
        TE.toggleFlyCam();
        el('btn-fly').classList.add('active');
        var fcBarInit = el('fly-cam-bar');
        if (fcBarInit) fcBarInit.style.display = 'flex';
        // Apply default fly speeds so the camera starts at the slider values
        TE.setFlyCamSpeed(100);
        TE.setFlyCamLookSpeed(10);

        // Register a per-frame hook to keep the camera marker in the preview up-to-date
        // while the 3D (paint) tab is active. Throttled to ~10 fps to avoid wasted work.
        var _lastPreviewRefresh = 0;
        var _scene = TE.getScene();
        if (_scene) {
            _scene.registerAfterRender(function () {
                if (state.activeTab !== 'paint' && state.activeTab !== 'view' && state.activeTab !== 'noise') return;
                var now = performance.now();
                if (now - _lastPreviewRefresh < 100) return; // ~10 fps throttle
                _lastPreviewRefresh = now;
                refreshPreviewCanvas();
            });
        }

        setStatus('Ready — drag a .ter file onto the viewport or use Import. WASD/Q/E to fly, right-drag to look.');

        // Redraw 2D canvas on resize so it stays square
        window.addEventListener('resize', function () {
            if (state.activeTab === 'edit2d') draw2dCanvas();
            if (state.activeTab === 'texture') drawTexCanvas();
            if (state.activeTab === 'imgedit') drawImgEditCanvas();
        });
    });

    window.TerEdit = TE;

}(TerEdit));
