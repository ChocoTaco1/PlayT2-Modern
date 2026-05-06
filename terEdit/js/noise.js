/**
 * noise.js
 * Simplex noise, fBm, ridge, and domain-warp implementations.
 * Also provides terrain generation (fills a Float32Array[256*256]).
 *
 * Based on Stefan Gustavson's public-domain simplex noise algorithm.
 */

/* global TerEdit */
var TerEdit = window.TerEdit || {};

(function (TE) {
    'use strict';

    // -----------------------------------------------------------------------
    // Simplex noise helpers
    // -----------------------------------------------------------------------

    var GRAD3 = [
        [ 1, 1, 0], [-1, 1, 0], [ 1,-1, 0], [-1,-1, 0],
        [ 1, 0, 1], [-1, 0, 1], [ 1, 0,-1], [-1, 0,-1],
        [ 0, 1, 1], [ 0,-1, 1], [ 0, 1,-1], [ 0,-1,-1]
    ];

    var F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
    var G2 = (3.0 - Math.sqrt(3.0)) / 6.0;

    function dot2(g, x, y) { return g[0] * x + g[1] * y; }

    /**
     * Build a 512-entry permutation table from an integer seed (LCG shuffle).
     */
    function buildPerm(seed) {
        var p = new Uint8Array(256);
        var i;
        for (i = 0; i < 256; i++) p[i] = i;

        var r = (seed | 0) >>> 0;
        for (i = 255; i > 0; i--) {
            r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
            var j = r % (i + 1);
            var tmp = p[i]; p[i] = p[j]; p[j] = tmp;
        }

        var perm = new Uint8Array(512);
        for (i = 0; i < 512; i++) perm[i] = p[i & 255];
        return perm;
    }

    /**
     * Single 2-D simplex noise sample.  Returns a value in [-1, 1].
     */
    function simplex2(xin, yin, perm) {
        var n0, n1, n2;
        var s  = (xin + yin) * F2;
        var i  = Math.floor(xin + s);
        var j  = Math.floor(yin + s);
        var t  = (i + j) * G2;
        var x0 = xin - (i - t);
        var y0 = yin - (j - t);

        var i1, j1;
        if (x0 > y0) { i1 = 1; j1 = 0; }
        else          { i1 = 0; j1 = 1; }

        var x1 = x0 - i1 + G2;
        var y1 = y0 - j1 + G2;
        var x2 = x0 - 1.0 + 2.0 * G2;
        var y2 = y0 - 1.0 + 2.0 * G2;

        var ii  = i & 255;
        var jj  = j & 255;
        var gi0 = perm[ii      + perm[jj     ]] % 12;
        var gi1 = perm[ii + i1 + perm[jj + j1]] % 12;
        var gi2 = perm[ii + 1  + perm[jj + 1 ]] % 12;

        var t0 = 0.5 - x0 * x0 - y0 * y0;
        n0 = (t0 < 0) ? 0.0 : (t0 *= t0, t0 * t0 * dot2(GRAD3[gi0], x0, y0));

        var t1 = 0.5 - x1 * x1 - y1 * y1;
        n1 = (t1 < 0) ? 0.0 : (t1 *= t1, t1 * t1 * dot2(GRAD3[gi1], x1, y1));

        var t2 = 0.5 - x2 * x2 - y2 * y2;
        n2 = (t2 < 0) ? 0.0 : (t2 *= t2, t2 * t2 * dot2(GRAD3[gi2], x2, y2));

        return 70.0 * (n0 + n1 + n2); // result in [-1, 1]
    }

    // -----------------------------------------------------------------------
    // Octave compositing helpers
    // -----------------------------------------------------------------------

    /** Fractional Brownian Motion – returns value in [-1, 1] */
    function fbm(x, y, octaves, persistence, lacunarity, perm) {
        var value = 0.0;
        var amp   = 1.0;
        var freq  = 1.0;
        var max   = 0.0;
        for (var o = 0; o < octaves; o++) {
            value += simplex2(x * freq, y * freq, perm) * amp;
            max   += amp;
            amp   *= persistence;
            freq  *= lacunarity;
        }
        return value / max;
    }

    /**
     * Ridge noise – creates sharp mountain ridges by inverting the absolute
     * value of each octave.  Returns value roughly in [0, 1].
     */
    function ridgeNoise(x, y, octaves, persistence, lacunarity, perm) {
        var value  = 0.0;
        var amp    = 1.0;
        var freq   = 1.0;
        var max    = 0.0;
        var weight = 1.0;
        for (var o = 0; o < octaves; o++) {
            var n = simplex2(x * freq, y * freq, perm);
            n = 1.0 - Math.abs(n); // ridge
            n = n * n * weight;
            weight = Math.min(1.0, Math.max(0.0, n * 2.0));
            value += n * amp;
            max   += amp;
            amp   *= persistence;
            freq  *= lacunarity;
        }
        return value / max;
    }

    /**
     * Domain-warped fBm – produces very organic, twisted terrain.
     * Returns value in roughly [-1, 1].
     */
    function warpedFbm(x, y, octaves, persistence, lacunarity, warpScale, perm) {
        var qx = fbm(x + 0.0,       y + 0.0,       octaves, persistence, lacunarity, perm);
        var qy = fbm(x + 5.2,       y + 1.3,       octaves, persistence, lacunarity, perm);
        return  fbm(x + warpScale * qx, y + warpScale * qy, octaves, persistence, lacunarity, perm);
    }

    // -----------------------------------------------------------------------
    // Public generation API
    // -----------------------------------------------------------------------

    /**
     * Generate a full 256×256 terrain.
     *
     * params {
     *   type        : 'fbm' | 'ridge' | 'warp',
     *   scale       : number  (noise frequency multiplier, e.g. 0.003–0.02)
     *   octaves     : int     (1–8)
     *   persistence : number  (0.1–0.9)
     *   lacunarity  : number  (1.5–4.0)
     *   warpScale   : number  (domain-warp strength, 1–4)
     *   seed        : int
     *   minHeight   : number  (metres)
     *   maxHeight   : number  (metres)
     *   operation   : 'set' | 'add' | 'subtract' | 'max' | 'min' | 'multiply'
     *   existingHeights : Float32Array (needed for add/subtract/max/min/multiply)
     * }
     *
     * Returns a new Float32Array[256*256] with the result.
     */
    TE.generateNoise = function (params) {
        var type        = params.type        || 'fbm';
        var scale       = params.scale       || 0.006;
        var octaves     = params.octaves     || 6;
        var persistence = params.persistence || 0.5;
        var lacunarity  = params.lacunarity  || 2.0;
        var warpScale   = params.warpScale   || 2.0;
        var seed        = params.seed        || 0;
        var minH        = params.minHeight   !== undefined ? params.minHeight : 0;
        var maxH        = params.maxHeight   !== undefined ? params.maxHeight : 300;
        var operation   = params.operation   || 'set';
        var existing    = params.existingHeights;

        var perm   = buildPerm(seed);
        var N      = TE.BLOCK;
        var result = new Float32Array(N * N);

        // First pass: generate normalised noise values [-1..1] or [0..1]
        var raw = new Float32Array(N * N);
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var nx = x * scale;
                var ny = y * scale;
                var v;
                if (type === 'ridge') {
                    v = ridgeNoise(nx, ny, octaves, persistence, lacunarity, perm);
                } else if (type === 'warp') {
                    v = warpedFbm(nx, ny, octaves, persistence, lacunarity, warpScale, perm);
                } else {
                    v = fbm(nx, ny, octaves, persistence, lacunarity, perm);
                }
                raw[x + y * N] = v;
            }
        }

        // Normalise to [0, 1]
        var lo = raw[0], hi = raw[0];
        for (var i = 1; i < N * N; i++) {
            if (raw[i] < lo) lo = raw[i];
            if (raw[i] > hi) hi = raw[i];
        }
        var range = (hi - lo) || 1.0;
        var hRange = maxH - minH;

        // Second pass: map to height range and apply operation
        for (var i = 0; i < N * N; i++) {
            var normalised = (raw[i] - lo) / range;       // [0, 1]
            var noiseH     = minH + normalised * hRange;  // metres

            var cur = (existing ? existing[i] : 0.0);

            switch (operation) {
                case 'add':      result[i] = cur + noiseH;           break;
                case 'subtract': result[i] = cur - noiseH;           break;
                case 'max':      result[i] = Math.max(cur, noiseH);  break;
                case 'min':      result[i] = Math.min(cur, noiseH);  break;
                case 'multiply': result[i] = cur * (noiseH / (hRange || 1)); break;
                default:         result[i] = noiseH;                 break; // 'set'
            }

            // Clamp to valid TGE height range (0 – 2047.97 m)
            result[i] = Math.max(0, Math.min(TE.HMAX, result[i]));
        }

        return result;
    };

    /**
     * Particle-based water erosion simulation (Sebastian Lague style).
     *
     * Normalises heights to [0,1] internally so all parameters are scale-independent,
     * producing fractal river-channel carving regardless of terrain height range.
     *
     * @param {Float32Array} heights
     * @param {object}       params   – all optional
     *   numDroplets            {number}  droplets to simulate (default 50000)
     *   maxLifetime            {number}  max steps per droplet (default 64)
     *   inertia                {number}  direction persistence [0–1] (default 0.35)
     *   sedimentCapacityFactor {number}  carry capacity multiplier (default 8)
     *   minSedimentCapacity    {number}  floor for capacity (default 0.002)
     *   erodeSpeed             {number}  erosion rate [0–1] (default 0.35)
     *   depositSpeed           {number}  deposit rate [0–1] (default 0.35)
     *   evaporateSpeed         {number}  water loss per step [0–1] (default 0.02)
     *   gravity                {number}  acceleration factor (default 10)
     */
    TE.waterErosion = function (heights, params) {
        params = params || {};
        var numDroplets  = params.numDroplets            || 50000;
        var maxLifetime  = params.maxLifetime            || 64;
        var inertia      = params.inertia                !== undefined ? params.inertia     : 0.35;
        var sedCapFactor = params.sedimentCapacityFactor || 8;
        var minSedCap    = params.minSedimentCapacity    || 0.002;
        var erodeSpeed   = params.erodeSpeed             !== undefined ? params.erodeSpeed  : 0.35;
        var depositSpeed = params.depositSpeed           !== undefined ? params.depositSpeed : 0.35;
        var evapSpeed    = params.evaporateSpeed         || 0.02;
        var gravity      = params.gravity                || 10;

        var Nb   = TE.BLOCK;  // 256
        var HMAX2 = TE.HMAX;

        // ── Normalise to [0,1] so parameters are height-scale-independent ──
        var rawLo = heights[0], rawHi = heights[0];
        for (var i = 1; i < Nb * Nb; i++) {
            if (heights[i] < rawLo) rawLo = heights[i];
            if (heights[i] > rawHi) rawHi = heights[i];
        }
        var rawRange = rawHi - rawLo;
        if (rawRange < 1) return;   // flat terrain – nothing to erode

        var map = new Float32Array(Nb * Nb);
        for (var i = 0; i < Nb * Nb; i++) map[i] = (heights[i] - rawLo) / rawRange;

        // ── LCG for repeatable droplet positions ──
        var rngState = 12345;
        function lcgNext() {
            rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
            return rngState / 0x100000000;
        }

        function sampleHeight(x, y) {
            var xi = x < 0 ? 0 : (x >= Nb - 1 ? Nb - 2 : Math.floor(x));
            var yi = y < 0 ? 0 : (y >= Nb - 1 ? Nb - 2 : Math.floor(y));
            var fx = x - xi, fy = y - yi;
            return map[xi     + yi * Nb]       * (1 - fx) * (1 - fy) +
                   map[xi + 1 + yi * Nb]       * fx       * (1 - fy) +
                   map[xi     + (yi + 1) * Nb] * (1 - fx) * fy       +
                   map[xi + 1 + (yi + 1) * Nb] * fx       * fy;
        }

        function sampleGradient(x, y) {
            var xi = x < 0 ? 0 : (x >= Nb - 1 ? Nb - 2 : Math.floor(x));
            var yi = y < 0 ? 0 : (y >= Nb - 1 ? Nb - 2 : Math.floor(y));
            var fx = x - xi, fy = y - yi;
            var h00 = map[xi     + yi * Nb];
            var h10 = map[xi + 1 + yi * Nb];
            var h01 = map[xi     + (yi + 1) * Nb];
            var h11 = map[xi + 1 + (yi + 1) * Nb];
            return {
                gx: (h10 - h00) * (1 - fy) + (h11 - h01) * fy,
                gy: (h01 - h00) * (1 - fx) + (h11 - h10) * fx
            };
        }

        // ── Simulate droplets ──
        for (var d = 0; d < numDroplets; d++) {
            var posX = lcgNext() * (Nb - 2);
            var posY = lcgNext() * (Nb - 2);
            var dirX = 0, dirY = 0;
            var speed    = 1;
            var water    = 1;
            var sediment = 0;

            for (var step = 0; step < maxLifetime; step++) {
                var nodeX = Math.floor(posX);
                var nodeY = Math.floor(posY);
                var cellX = posX - nodeX;
                var cellY = posY - nodeY;

                if (nodeX < 0 || nodeX >= Nb - 1 || nodeY < 0 || nodeY >= Nb - 1) break;

                var g = sampleGradient(posX, posY);

                // Blend direction with gradient (inertia keeps the stream flowing)
                dirX = dirX * inertia - g.gx * (1 - inertia);
                dirY = dirY * inertia - g.gy * (1 - inertia);

                var len = Math.sqrt(dirX * dirX + dirY * dirY);
                if (len < 1e-8) {
                    dirX = lcgNext() * 2 - 1;
                    dirY = lcgNext() * 2 - 1;
                    len  = Math.sqrt(dirX * dirX + dirY * dirY);
                }
                dirX /= len;
                dirY /= len;

                var newX = posX + dirX;
                var newY = posY + dirY;
                if (newX < 0 || newX >= Nb - 1 || newY < 0 || newY >= Nb - 1) break;

                var oldH = sampleHeight(posX, posY);
                var newH = sampleHeight(newX, newY);
                var dH   = newH - oldH;   // positive = uphill, negative = downhill

                // Sediment capacity ∝ speed × water × max(0, slope)
                var sedCap = Math.max(-dH * speed * water * sedCapFactor, minSedCap);

                var w00 = (1 - cellX) * (1 - cellY);
                var w10 = cellX       * (1 - cellY);
                var w01 = (1 - cellX) * cellY;
                var w11 = cellX       * cellY;

                if (sediment > sedCap || dH > 0) {
                    // Deposit excess sediment (or all if going uphill)
                    var deposit = dH > 0
                        ? Math.min(sediment, dH)          // fill the uphill step
                        : (sediment - sedCap) * depositSpeed;
                    sediment -= deposit;
                    map[nodeX     + nodeY * Nb]       = Math.min(1, map[nodeX     + nodeY * Nb]       + deposit * w00);
                    map[nodeX + 1 + nodeY * Nb]       = Math.min(1, map[nodeX + 1 + nodeY * Nb]       + deposit * w10);
                    map[nodeX     + (nodeY + 1) * Nb] = Math.min(1, map[nodeX     + (nodeY + 1) * Nb] + deposit * w01);
                    map[nodeX + 1 + (nodeY + 1) * Nb] = Math.min(1, map[nodeX + 1 + (nodeY + 1) * Nb] + deposit * w11);
                } else {
                    // Erode proportional to capacity deficit
                    var erode = Math.min((sedCap - sediment) * erodeSpeed, -dH);
                    sediment += erode;
                    map[nodeX     + nodeY * Nb]       = Math.max(0, map[nodeX     + nodeY * Nb]       - erode * w00);
                    map[nodeX + 1 + nodeY * Nb]       = Math.max(0, map[nodeX + 1 + nodeY * Nb]       - erode * w10);
                    map[nodeX     + (nodeY + 1) * Nb] = Math.max(0, map[nodeX     + (nodeY + 1) * Nb] - erode * w01);
                    map[nodeX + 1 + (nodeY + 1) * Nb] = Math.max(0, map[nodeX + 1 + (nodeY + 1) * Nb] - erode * w11);
                }

                speed = Math.sqrt(Math.max(0, speed * speed + (-dH) * gravity));
                water *= (1 - evapSpeed);
                if (water < 0.001) break;
                posX = newX;
                posY = newY;
            }
        }

        // ── Write normalised map back to original height range ──
        for (var i = 0; i < Nb * Nb; i++) {
            heights[i] = Math.max(0, Math.min(HMAX2, rawLo + map[i] * rawRange));
        }
    };

    /**
     * Normalise heights so the range maps to [minH, maxH].
     */
    TE.normaliseHeights = function (heights, minH, maxH) {
        var lo = heights[0], hi = heights[0];
        for (var i = 1; i < heights.length; i++) {
            if (heights[i] < lo) lo = heights[i];
            if (heights[i] > hi) hi = heights[i];
        }
        var range = hi - lo;
        if (range < 0.001) return;
        var hRange = maxH - minH;
        for (var i = 0; i < heights.length; i++) {
            heights[i] = minH + ((heights[i] - lo) / range) * hRange;
        }
    };

    window.TerEdit = TE;

}(TerEdit));
