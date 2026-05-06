/**
 * terrain3d.js
 * Babylon.js terrain rendering for the terEdit tool.
 *
 * Grid layout:
 *   heights[x + y*256] → world position ((x-128)*8, height, (y-128)*8)
 * The terrain is centred at the world origin with scale=8 units per cell.
 */

/* global TerEdit, BABYLON */
var TerEdit = window.TerEdit || {};

(function (TE) {
    'use strict';

    var N     = 256;   // grid cells per side
    var SCALE = 8;     // world units per grid cell

    var engine      = null;
    var scene       = null;
    var arcCamera   = null;   // ArcRotateCamera (default orbit view)
    var flyCamera   = null;   // UniversalCamera (free-fly mode)
    var camMode     = 'arc';  // 'arc' | 'fly'
    var storeCanvas = null;   // canvas reference kept for camera toggling
    var terrainMesh = null;
    var brushCursor = null;   // LineSystem mesh for vertex indicator squares
    var dirLight    = null;
    var ambLight    = null;
    var gridLines   = null;

    // Throttle state for brush cursor rebuild
    var lastCursorGX      = -9999;
    var lastCursorGY      = -9999;
    var lastCursorRadius  = -1;
    var lastCursorFalloff = '';

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    /**
     * Initialise the Babylon.js engine and scene on the given canvas.
     * @param {HTMLCanvasElement} canvas
     * @returns {BABYLON.Scene}
     */
    TE.initScene = function (canvas) {
        storeCanvas = canvas;
        engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true });

        scene = new BABYLON.Scene(engine);
        scene.clearColor = new BABYLON.Color4(0.12, 0.12, 0.14, 1);

        // Arc-rotate camera – left-click to orbit, middle/scroll to zoom, right-click to pan
        arcCamera = new BABYLON.ArcRotateCamera(
            'cam', -Math.PI / 4, Math.PI / 3.5, 1400, BABYLON.Vector3.Zero(), scene
        );
        arcCamera.lowerRadiusLimit  = 30;
        arcCamera.upperRadiusLimit  = 4000;
        arcCamera.wheelPrecision    = 2;
        arcCamera.panningSensibility = 200;
        arcCamera.panningAxis = new BABYLON.Vector3(1, 0, 1); // pan on XZ plane only
        arcCamera.attachControl(canvas, true);

        // Lighting tuned for comfortable terrain editing
        dirLight = new BABYLON.DirectionalLight(
            'sun', new BABYLON.Vector3(-0.5, -1, -0.5), scene
        );
        dirLight.intensity = 0.9;

        ambLight = new BABYLON.HemisphericLight(
            'sky', new BABYLON.Vector3(0, 1, 0), scene
        );
        ambLight.intensity   = 0.4;
        ambLight.diffuse     = new BABYLON.Color3(1, 1, 1);
        ambLight.groundColor = new BABYLON.Color3(0.3, 0.28, 0.25);

        // Render loop
        engine.runRenderLoop(function () { scene.render(); });
        window.addEventListener('resize', function () { engine.resize(); });

        return scene;
    };

    // -----------------------------------------------------------------------
    // Terrain mesh
    // -----------------------------------------------------------------------

    /**
     * Build vertex data (positions, indices, UVs) from the heights array.
     * Vertices are ordered: row-major (y outer, x inner), y=0 at z=-128*8.
     */
    function buildVertexData(heights) {
        var positions = new Float32Array(N * N * 3);
        var uvs       = new Float32Array(N * N * 2);
        var indices   = [];
        var normals   = new Float32Array(N * N * 3);

        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var vi  = (y * N + x) * 3;
                var uvi = (y * N + x) * 2;
                positions[vi]     = (x - N / 2) * SCALE;
                positions[vi + 1] = heights[x + y * N];
                positions[vi + 2] = (y - N / 2) * SCALE;
                uvs[uvi]          = x / (N - 1);
                uvs[uvi + 1]      = y / (N - 1);
            }
        }

        // Winding order: a,b,c and b,d,c produces upward-facing normals in Babylon.js
        for (var y = 0; y < N - 1; y++) {
            for (var x = 0; x < N - 1; x++) {
                var a = y * N + x;
                var b = a + 1;
                var c = a + N;
                var d = c + 1;
                indices.push(a, b, c);
                indices.push(b, d, c);
            }
        }

        BABYLON.VertexData.ComputeNormals(positions, indices, normals);

        var vd       = new BABYLON.VertexData();
        vd.positions = positions;
        vd.indices   = indices;
        vd.normals   = normals;
        vd.uvs       = uvs;
        return vd;
    }

    /**
     * Create (or recreate) the terrain mesh from a heights array.
     * @param {Float32Array} heights
     */
    TE.createTerrainMesh = function (heights) {
        if (terrainMesh) {
            terrainMesh.dispose();
            terrainMesh = null;
        }

        terrainMesh = new BABYLON.Mesh('terrain', scene);
        buildVertexData(heights).applyToMesh(terrainMesh, true /* updatable */);

        var mat = new BABYLON.StandardMaterial('terrainMat', scene);
        mat.diffuseColor  = new BABYLON.Color3(0.82, 0.77, 0.70);
        mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
        terrainMesh.material = mat;

        return terrainMesh;
    };

    /**
     * Update only vertex heights and recompute normals.
     * Optionally restrict to a dirty region for performance.
     * @param {Float32Array} heights
     * @param {object|null}  dirty  { x0, x1, y0, y1 } in grid coords (null = full update)
     */
    TE.updateTerrainHeights = function (heights, dirty) {
        if (!terrainMesh) return;

        var positions = terrainMesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);

        if (!dirty) {
            // Full update
            for (var y = 0; y < N; y++) {
                for (var x = 0; x < N; x++) {
                    positions[(y * N + x) * 3 + 1] = heights[x + y * N];
                }
            }
        } else {
            var px = Math.max(0, dirty.x0 - 1), px1 = Math.min(N - 1, dirty.x1 + 1);
            var py = Math.max(0, dirty.y0 - 1), py1 = Math.min(N - 1, dirty.y1 + 1);
            for (var y = py; y <= py1; y++) {
                for (var x = px; x <= px1; x++) {
                    positions[(y * N + x) * 3 + 1] = heights[x + y * N];
                }
            }
        }

        terrainMesh.updateVerticesData(BABYLON.VertexBuffer.PositionKind, positions);

        // Recompute normals
        var indices = terrainMesh.getIndices();
        var normals = new Float32Array(N * N * 3);
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);
        terrainMesh.updateVerticesData(BABYLON.VertexBuffer.NormalKind, normals);
        terrainMesh.refreshBoundingInfo();
    };

    // -----------------------------------------------------------------------
    // Brush cursor – TGE-style per-vertex coloured square indicators
    // -----------------------------------------------------------------------

    /**
     * Reset internal state so the next updateBrushCursor call always rebuilds.
     * Called when a new terrain is loaded or created.
     */
    TE.createBrushCursor = function () {
        if (brushCursor) { brushCursor.dispose(); brushCursor = null; }
        lastCursorGX      = -9999;
        lastCursorGY      = -9999;
        lastCursorRadius  = -1;
        lastCursorFalloff = '';
    };

    /**
     * Update the TGE-style vertex cursor.
     *
     * For each terrain vertex inside the brush radius, a small coloured square
     * outline is drawn at the terrain surface height:
     *   • Red  = full brush weight (centre)
     *   • Green = zero weight (outer edge)
     *
     * Rebuilds the mesh only when the cursor position, radius or falloff change
     * by a meaningful amount (throttle to avoid rebuilding every mouse event).
     *
     * @param {BABYLON.Vector3|null} worldPos   null → hide cursor
     * @param {number}               radius     brush radius in grid cells
     * @param {Float32Array|null}    heights    terrain height array
     * @param {string}               falloffName  falloff profile name
     */
    TE.updateBrushCursor = function (worldPos, radius, heights, falloffName, forceRebuild) {
        if (!worldPos || !heights) {
            if (brushCursor) { brushCursor.dispose(); brushCursor = null; }
            return;
        }

        var cx = worldPos.x / SCALE + N / 2;
        var cy = worldPos.z / SCALE + N / 2;
        falloffName = falloffName || 'smooth';

        // Skip rebuild when nothing meaningful has changed
        if (!forceRebuild &&
            brushCursor &&
            Math.abs(cx - lastCursorGX) < 0.4 &&
            Math.abs(cy - lastCursorGY) < 0.4 &&
            radius === lastCursorRadius &&
            falloffName === lastCursorFalloff) {
            return;
        }

        lastCursorGX      = cx;
        lastCursorGY      = cy;
        lastCursorRadius  = radius;
        lastCursorFalloff = falloffName;

        if (brushCursor) { brushCursor.dispose(); brushCursor = null; }

        var r    = radius;
        var rInt = Math.ceil(r);
        var x0   = Math.max(0, Math.round(cx) - rInt);
        var x1   = Math.min(N - 1, Math.round(cx) + rInt);
        var y0   = Math.max(0, Math.round(cy) - rInt);
        var y1   = Math.min(N - 1, Math.round(cy) + rInt);

        var hs = 3.4;   // half-side of each indicator square (world units, < SCALE/2=4)
        var oy = 0.4;   // vertical offset above the terrain surface

        // TE.computeWeight is exported from brushTools.js
        var weightFn = TE.computeWeight || function (d, r2) { return d < r2 ? 1 - d / r2 : 0; };

        var linesArr  = [];
        var colorsArr = [];

        for (var y = y0; y <= y1; y++) {
            for (var x = x0; x <= x1; x++) {
                var dx   = x - cx;
                var dy   = y - cy;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist >= r) continue;   // only cells with nonzero weight (matches actual brush effect)

                var w  = weightFn(dist, r, falloffName);

                // w=1 (centre) → red,   w=0 (edge) → green
                var col = new BABYLON.Color4(w, 1 - w, 0.0, 1.0);

                var wx = (x - N / 2) * SCALE;
                var wz = (y - N / 2) * SCALE;
                var wy = heights[x + y * N] + oy;

                // Closed square outline: 5 points (last = first to close the loop)
                linesArr.push([
                    new BABYLON.Vector3(wx - hs, wy, wz - hs),
                    new BABYLON.Vector3(wx + hs, wy, wz - hs),
                    new BABYLON.Vector3(wx + hs, wy, wz + hs),
                    new BABYLON.Vector3(wx - hs, wy, wz + hs),
                    new BABYLON.Vector3(wx - hs, wy, wz - hs)
                ]);
                colorsArr.push([col, col, col, col, col]);
            }
        }

        if (linesArr.length === 0) return;

        brushCursor = BABYLON.MeshBuilder.CreateLineSystem('brushCursor', {
            lines  : linesArr,
            colors : colorsArr
        }, scene);
        brushCursor.isPickable = false;
    };

    // -----------------------------------------------------------------------
    // Grid overlay
    // -----------------------------------------------------------------------

    TE.setGridVisible = function (visible) {
        if (!gridLines && visible) {
            // 16-cell grid lines (every 16 grid squares = 128 world units)
            var lines = [];
            var halfW = (N / 2) * SCALE;
            var step  = 16 * SCALE;
            for (var i = 0; i <= N; i += 16) {
                var wx = (i - N / 2) * SCALE;
                lines.push([
                    new BABYLON.Vector3(wx, 0.5, -halfW),
                    new BABYLON.Vector3(wx, 0.5,  halfW)
                ]);
                lines.push([
                    new BABYLON.Vector3(-halfW, 0.5, wx),
                    new BABYLON.Vector3( halfW, 0.5, wx)
                ]);
            }
            gridLines = BABYLON.MeshBuilder.CreateLineSystem('grid', { lines: lines }, scene);
            gridLines.color = new BABYLON.Color3(0.4, 0.4, 0.4);
            gridLines.isPickable = false;
        }
        if (gridLines) gridLines.setEnabled(visible);
    };

    // -----------------------------------------------------------------------
    // Picking
    // -----------------------------------------------------------------------

    /**
     * Cast a pick ray from the pointer position and return the grid coordinates
     * of the hit point, or null if the terrain wasn't hit.
     * @returns {{ gx: number, gy: number, world: BABYLON.Vector3 }|null}
     */
    TE.pickTerrain = function () {
        if (!terrainMesh) return null;
        var hit = scene.pick(scene.pointerX, scene.pointerY, function (m) {
            return m === terrainMesh;
        });
        if (!hit || !hit.hit || !hit.pickedPoint) return null;

        var wx = hit.pickedPoint.x;
        var wz = hit.pickedPoint.z;
        var gx = wx / SCALE + N / 2;
        var gy = wz / SCALE + N / 2;

        return {
            gx    : Math.max(0, Math.min(N - 1, gx)),
            gy    : Math.max(0, Math.min(N - 1, gy)),
            world : hit.pickedPoint
        };
    };

    // -----------------------------------------------------------------------
    // Camera helpers
    // -----------------------------------------------------------------------

    TE.resetCamera = function () {
        arcCamera.alpha  = -Math.PI / 4;
        arcCamera.beta   = Math.PI / 3.5;
        arcCamera.radius = 1400;
        arcCamera.target = BABYLON.Vector3.Zero();
    };

    TE.topDownCamera = function () {
        arcCamera.alpha  = -Math.PI / 2;
        arcCamera.beta   = 0.02;    // small offset from zenith avoids ArcRotate singularity
        arcCamera.radius = 1600;
        arcCamera.target = BABYLON.Vector3.Zero();
    };

    /**
     * Toggle free-fly camera (UniversalCamera).
     * Movement : WASD to strafe/walk, Q/E to descend/ascend.
     * Look     : right-click drag to look around.
     * Left-click remains free for terrain painting.
     * @returns {string}  new camMode – 'arc' or 'fly'
     */
    TE.toggleFlyCam = function () {
        var canvas = storeCanvas;
        if (camMode === 'arc') {
            arcCamera.detachControl();

            flyCamera = new BABYLON.UniversalCamera('flyCam', arcCamera.position.clone(), scene);
            flyCamera.setTarget(arcCamera.target.clone());
            flyCamera.speed              = 15;    // world-units per second
            flyCamera.minZ               = 2;
            flyCamera.inertia            = 0;     // disable momentum / look acceleration
            flyCamera.angularSensibility = 1500;  // lower = faster look; default was 2000

            // Use right mouse button (button index 2) for look so left stays free for painting
            if (flyCamera.inputs && flyCamera.inputs.attached) {
                var mi = flyCamera.inputs.attached.mouse ||
                         flyCamera.inputs.attached.mouserotation;
                if (mi) { mi.buttons = [2]; }
            }

            flyCamera.keysUp       = [87]; // W – forward
            flyCamera.keysDown     = [83]; // S – backward
            flyCamera.keysLeft     = [65]; // A – strafe left
            flyCamera.keysRight    = [68]; // D – strafe right
            flyCamera.keysUpward   = [69]; // E – ascend
            flyCamera.keysDownward = [81]; // Q – descend

            flyCamera.attachControl(canvas, true);
            scene.activeCamera = flyCamera;
            camMode = 'fly';
        } else {
            flyCamera.detachControl();
            flyCamera.dispose();
            flyCamera = null;

            arcCamera.attachControl(canvas, true);
            scene.activeCamera = arcCamera;
            camMode = 'arc';
        }
        return camMode;
    };

    TE.getCamMode = function () { return camMode; };

    /**
     * Multiply the fly camera movement speed by a factor (clamped to [5, 2000]).
     * @param {number} factor  e.g. 1.1 to go faster, 0.9 to go slower
     */
    TE.adjustFlyCamSpeed = function (factor) {
        if (!flyCamera) return;
        flyCamera.speed = Math.max(5, Math.min(2000, flyCamera.speed * factor));
        return flyCamera.speed;
    };

    /**
     * Multiply the fly camera look sensitivity by a factor.
     * angularSensibility: lower value = faster look.
     * Clamped to [300, 6000].
     * @param {number} factor  e.g. 0.9 to look faster, 1.1 to look slower
     */
    TE.adjustFlyCamSensitivity = function (factor) {
        if (!flyCamera) return;
        flyCamera.angularSensibility = Math.max(300, Math.min(6000, flyCamera.angularSensibility * factor));
        return flyCamera.angularSensibility;
    };

    /**
     * Set fly camera move speed directly.
     * @param {number} v  speed in world-units/s (clamped to [5, 2000])
     */
    TE.setFlyCamSpeed = function (v) {
        if (!flyCamera) return;
        flyCamera.speed = Math.max(5, Math.min(2000, v));
    };

    /**
     * Set fly camera angular sensibility directly.
     * Lower = faster look. lookSpeed is a 1-20 scale where higher = faster;
     * internally maps to angularSensibility = 7500 / lookSpeed.
     * @param {number} lookSpeed  1 (slowest) – 20 (fastest)
     */
    TE.setFlyCamLookSpeed = function (lookSpeed) {
        if (!flyCamera) return;
        flyCamera.angularSensibility = Math.max(300, Math.min(7500, Math.round(7500 / lookSpeed)));
    };

    // -----------------------------------------------------------------------
    // Alpha-map overlay on terrain (used in Texture tab)
    // -----------------------------------------------------------------------

    var alphaOverlayTexture = null;

    /**
     * Paint one alpha-map layer as a coloured emissive overlay on the terrain.
     * Where alphaMap[i]=255 the terrain gets a strong tint; 0 = no tint.
     *
     * @param {Uint8Array|null} alphaMap  256×256 alpha values (null → all-black, "no data")
     * @param {number[3]}       rgb       tint colour [r,g,b] in 0-1 range
     */
    TE.setAlphaOverlay = function (alphaMap, rgb) {
        if (!terrainMesh || !scene) return;
        var mat = terrainMesh.material;
        if (!mat) return;

        var N2 = N;   // 256

        if (!alphaOverlayTexture) {
            alphaOverlayTexture = new BABYLON.DynamicTexture(
                'alphaOverlay', { width: N2, height: N2 }, scene, false
            );
        }

        var ctx    = alphaOverlayTexture.getContext();
        var idata  = ctx.createImageData(N2, N2);
        var r255   = Math.round((rgb[0] || 0) * 255);
        var g255   = Math.round((rgb[1] || 0) * 255);
        var b255   = Math.round((rgb[2] || 0) * 255);

        for (var i = 0; i < N2 * N2; i++) {
            var v = alphaMap ? alphaMap[i] : 0;
            idata.data[i * 4]     = r255;
            idata.data[i * 4 + 1] = g255;
            idata.data[i * 4 + 2] = b255;
            idata.data[i * 4 + 3] = v;   // fully transparent where unpainted
        }
        ctx.putImageData(idata, 0, 0);
        alphaOverlayTexture.update();
        alphaOverlayTexture.hasAlpha = true;

        mat.emissiveTexture = alphaOverlayTexture;
        // Subtle tint — low emissiveColor so the terrain lighting still reads
        mat.emissiveColor = new BABYLON.Color3(0.35, 0.35, 0.35);
    };

    /**
     * Remove the alpha-map overlay from the terrain.
     */
    TE.clearAlphaOverlay = function () {
        if (!terrainMesh || !terrainMesh.material) return;
        var mat = terrainMesh.material;
        mat.emissiveTexture = null;
        mat.emissiveColor   = BABYLON.Color3.Black();
        if (alphaOverlayTexture) {
            alphaOverlayTexture.dispose();
            alphaOverlayTexture = null;
        }
    };

    TE.setWireframe = function (on) {
        if (terrainMesh && terrainMesh.material) {
            terrainMesh.material.wireframe = on;
        }
    };

    TE.getScene   = function () { return scene;   };
    TE.getEngine  = function () { return engine;  };
    TE.getCamera  = function () { return camMode === 'fly' ? flyCamera : arcCamera; };
    TE.getArcCamera = function () { return arcCamera; };
    TE.getTerMesh = function () { return terrainMesh; };

    window.TerEdit = TE;

}(TerEdit));
