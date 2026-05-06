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
        brushStrength : 5.0,    // metres per full stroke
        brushFalloff  : 'smooth',
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
            mirrorAngle : 0,      // degrees from vertical (0 = vertical line)
            mirrorEnabled : true, // false while stamp mode is active
            dragActive  : false,  // dragging on the 2D canvas to rotate mirror
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
        // Clear stamp mode when leaving the 2D edit tab
        if (state.activeTab === 'edit2d' && tab !== 'edit2d') {
            clearStampMode();
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

        if (tab === 'edit2d') {
            if (renderCanvas) renderCanvas.style.display = 'none';
            if (edit2dCanvas) { edit2dCanvas.style.display = 'block'; edit2dCanvas.style.cursor = 'crosshair'; }
            if (vpOverlay)    vpOverlay.style.display    = 'none';
            draw2dCanvas();
        } else if (tab === 'texture') {
            // Show the 2D canvas with the current alpha layer (no 3D view)
            if (renderCanvas) renderCanvas.style.display = 'none';
            if (edit2dCanvas) { edit2dCanvas.style.display = 'block'; edit2dCanvas.style.cursor = 'crosshair'; }
            if (vpOverlay)    vpOverlay.style.display    = 'none';
            renderTextureTab();
            drawTexCanvas();
        } else {
            if (renderCanvas) renderCanvas.style.display = 'block';
            if (edit2dCanvas) edit2dCanvas.style.display = 'none';
            if (vpOverlay)    vpOverlay.style.display    = '';

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

    function applyBrushAt(gx, gy) {
        if (!state.terrain) return;

        var h  = state.terrain.heights;
        var cx = gx, cy = gy;
        var r  = state.brushRadius;
        var s  = state.brushStrength;
        var fo = state.brushFalloff;

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

        var rInt = Math.ceil(r);
        var dirty = {
            x0 : Math.max(0, Math.round(cx) - rInt),
            x1 : Math.min(255, Math.round(cx) + rInt),
            y0 : Math.max(0, Math.round(cy) - rInt),
            y1 : Math.min(255, Math.round(cy) + rInt)
        };
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

        // Toggle free-fly camera — always available so the user can exit fly mode
        if (key === 'c') {
            var newMode = TE.toggleFlyCam();
            el('btn-fly').classList.toggle('active', newMode === 'fly');
            var fcBar = el('fly-cam-bar');
            if (fcBar) fcBar.style.display = newMode === 'fly' ? 'flex' : 'none';
            setStatus(newMode === 'fly'
                ? 'Fly mode — WASD/Q/E to move, right-drag to look. Press C or Fly to exit.'
                : 'Orbit camera restored.');
            return;
        }

        // In fly mode all remaining shortcuts are suppressed to avoid clashing
        // with WASD/Q/E/W/F/T/1-7 movement and look keys consumed by the camera.
        if (TE.getCamMode() === 'fly') return;

        // Tab switching
        if (key === 'v') switchTab('view');
        if (key === 'p') switchTab('paint');
        if (key === 'n') switchTab('noise');
        if (key === 'e') switchTab('edit2d');
        if (key === 'x') switchTab('texture');

        // Undo / Redo
        if ((evt.ctrlKey || evt.metaKey) && key === 'z') { undo(); return; }
        if ((evt.ctrlKey || evt.metaKey) && (key === 'y' || (evt.shiftKey && key === 'z'))) { redo(); return; }

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
        if (key === 'f') TE.resetCamera();
        if (key === 't') TE.topDownCamera();

        // Wireframe
        if (key === 'w') {
            state.wireframe = !state.wireframe;
            TE.setWireframe(state.wireframe);
            el('btn-wireframe').classList.toggle('active', state.wireframe);
        }
    }

    function adjustBrushRadius(delta) {
        state.brushRadius = Math.max(1, Math.min(50, state.brushRadius + delta));
        syncSlider('slider-radius', 'val-radius', state.brushRadius, state.brushRadius.toFixed(0));
        TE.updateBrushCursor(null, 0); // will be updated on next mouse move
    }

    function adjustBrushStrength(delta) {
        state.brushStrength = Math.max(0.5, Math.min(100, state.brushStrength + delta));
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

        el('btn-reset-cam').addEventListener('click', TE.resetCamera);
        el('btn-top-cam').addEventListener('click', TE.topDownCamera);

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
                if (state.activeTab === 'edit2d') draw2dCanvas();
                if (state.activeTab === 'texture') drawTexCanvas();
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

        // Wire 2D Edit tab
        wireEdit2dTab();
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
            TE.mirrorTerrain(state.terrain.heights, state.edit2d.mirrorAngle, 'srcA');
            applyHeightsToAll();
            setStatus('Mirrored A→B at ' + state.edit2d.mirrorAngle + '°.');
        });

        el('btn-mirror-b-to-a').addEventListener('click', function () {
            if (!state.terrain) return;
            pushUndo();
            TE.mirrorTerrain(state.terrain.heights, state.edit2d.mirrorAngle, 'srcB');
            applyHeightsToAll();
            setStatus('Mirrored B→A at ' + state.edit2d.mirrorAngle + '°.');
        });

        // Drag on 2D canvas to rotate mirror line; click to place measure points; click-to-stamp;
        // also handles texture alpha painting when texture tab is active
        var canvas2d = el('edit2d-canvas');
        if (canvas2d) {
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

                // Measure mode gets top priority
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

                // Stamp mode: left-click applies the stamp at the current mouse position
                if (state.edit2d.stamp.img && e.button === 0) {
                    if (!state.terrain) return;
                    var st2 = state.edit2d.stamp;
                    // Position was already updated in pointermove
                    pushUndo();
                    TE.applyStamp(state.terrain.heights,
                                  st2.imgData, st2.x, st2.y,
                                  st2.scale, st2.rotation || 0, st2.strength, st2.mode);
                    applyHeightsToAll();
                    setStatus('Stamp applied at (' + Math.round(st2.x) + ', ' + Math.round(st2.y) +
                              '), rot: ' + (st2.rotation || 0) + '\xb0.');
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

                // Stamp follows the mouse
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
            });
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

        // ── Stamp from PNG ─────────────────────────────────────────────────
        var stampInput = el('stamp-file-input');
        el('btn-load-stamp').addEventListener('click', function () {
            if (stampInput) stampInput.click();
        });

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
                    // Auto-disable mirror drag so clicks stamp instead of rotating mirror
                    state.edit2d.mirrorEnabled = false;
                    var bmt = el('btn-mirror-toggle');
                    if (bmt) { bmt.classList.remove('active'); bmt.textContent = '🪞 Mirror Line: Off'; }
                    // Loading stamp clears measure mode
                    if (state.edit2d.measuring) {
                        state.edit2d.measuring = false;
                        state.edit2d.measureA  = null;
                        state.edit2d.measureB  = null;
                        setHTML('measure-result', '');
                        var bmtog = el('btn-measure-toggle');
                        if (bmtog) bmtog.classList.remove('active');
                    }
                    // Show stamp canvas cursor
                    var cv2d = el('edit2d-canvas');
                    if (cv2d) cv2d.style.cursor = 'none';
                    var sc = el('stamp-controls');
                    if (sc) sc.style.display = '';
                    if (state.activeTab === 'edit2d') draw2dCanvas();
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

        el('btn-stamp-apply').addEventListener('click', function () {
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

        el('btn-stamp-clear').addEventListener('click', function () {
            clearStampMode();
            if (state.activeTab === 'edit2d') draw2dCanvas();
            setStatus('Stamp cleared.');
        });
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
                ';border-radius:4px;padding:6px 8px;margin-bottom:8px;background:#22222a;' +
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

        setStatus('Ready — drag a .ter file onto the viewport or use Import. WASD/Q/E to fly, right-drag to look.');

        // Redraw 2D canvas on resize so it stays square
        window.addEventListener('resize', function () {
            if (state.activeTab === 'edit2d')   draw2dCanvas();
            if (state.activeTab === 'texture') drawTexCanvas();
        });
    });

    window.TerEdit = TE;

}(TerEdit));
