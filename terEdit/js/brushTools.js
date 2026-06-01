/**
 * brushTools.js
 * Terrain-editing brush operations, matching TGE terrain editor functionality.
 *
 * All brushes operate on a Float32Array heights[256*256] in-place.
 * Heights are in metres (0 – 2047.97).
 */

/* global TerEdit */
var TerEdit = window.TerEdit || {};

(function (TE) {
    'use strict';

    var N    = 256;              // grid size
    var HMAX = 2047.96875;       // 65535 * 0.03125

    // -----------------------------------------------------------------------
    // Falloff profiles
    // -----------------------------------------------------------------------

    /**
     * Returns a weight in [0, 1] for a point at distance d from brush centre,
     * given brush radius r.
     *
     * @param {number} d        distance from centre
     * @param {number} r        brush radius
     * @param {string} profile  'hard' | 'linear' | 'smooth' | 'gaussian'
     */
    function falloff(d, r, profile) {
        if (d >= r) return 0;
        var t = d / r;  // [0, 1)
        switch (profile) {
            case 'hard':     return 1.0;
            case 'linear':   return 1.0 - t;
            case 'smooth':   return (1.0 - t * t) * (1.0 - t * t); // smooth quartic
            case 'gaussian': return Math.exp(-4.5 * t * t);
            default:         return 1.0 - t;
        }
    }

    /**
     * Iterate over all grid cells within radius of (cx, cy).
     * Calls cb(idx, x, y, weight) for each cell.
     */
    function eachCell(cx, cy, radius, profile, cb) {
        var r    = radius;
        var rInt = Math.ceil(r);
        var x0   = Math.max(0, Math.round(cx) - rInt);
        var x1   = Math.min(N - 1, Math.round(cx) + rInt);
        var y0   = Math.max(0, Math.round(cy) - rInt);
        var y1   = Math.min(N - 1, Math.round(cy) + rInt);

        for (var y = y0; y <= y1; y++) {
            for (var x = x0; x <= x1; x++) {
                var dx   = x - cx;
                var dy   = y - cy;
                var dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > r) continue;
                var w = falloff(dist, r, profile);
                cb(x + y * N, x, y, w);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Brush tools – each function modifies heights in-place
    // -----------------------------------------------------------------------

    /**
     * Raise height at brush position.
     * @param {Float32Array} heights
     * @param {number} cx, cy   grid coordinates (may be fractional)
     * @param {number} radius   brush radius in grid cells
     * @param {number} strength metres per full stroke
     * @param {string} falloffProfile
     */
    TE.brushRaise = function (heights, cx, cy, radius, strength, falloffProfile) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            heights[idx] = Math.min(HMAX, heights[idx] + strength * w);
        });
    };

    /**
     * Lower height at brush position.
     */
    TE.brushLower = function (heights, cx, cy, radius, strength, falloffProfile) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            heights[idx] = Math.max(0, heights[idx] - strength * w);
        });
    };

    /**
     * Flatten – moves all cells toward the weighted average height of the brush area.
     */
    TE.brushFlatten = function (heights, cx, cy, radius, strength, falloffProfile) {
        // First pass: compute weighted average
        var totalW = 0, totalH = 0;
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            totalW += w;
            totalH += heights[idx] * w;
        });
        if (totalW < 1e-6) return;
        var avg = totalH / totalW;

        // Second pass: blend toward average (clamp to [0,1] so we never overshoot)
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            heights[idx] += (avg - heights[idx]) * Math.min(1.0, w * strength);
        });
    };

    /**
     * Smooth – replaces each cell with the average of its 3×3 neighbourhood,
     * blended by falloff × strength.
     */
    TE.brushSmooth = function (heights, cx, cy, radius, strength, falloffProfile) {
        // Snapshot only the affected region to avoid write-order artifacts
        var rInt   = Math.ceil(radius) + 1;
        var rx0    = Math.max(0, Math.round(cx) - rInt);
        var rx1    = Math.min(N - 1, Math.round(cx) + rInt);
        var ry0    = Math.max(0, Math.round(cy) - rInt);
        var ry1    = Math.min(N - 1, Math.round(cy) + rInt);

        // Snapshot
        var snap = {};
        for (var sy = ry0; sy <= ry1; sy++) {
            for (var sx = rx0; sx <= rx1; sx++) {
                snap[sx + sy * N] = heights[sx + sy * N];
            }
        }

        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            var sum = 0, cnt = 0;
            for (var ky = -1; ky <= 1; ky++) {
                for (var kx = -1; kx <= 1; kx++) {
                    var nx2 = x + kx, ny2 = y + ky;
                    if (nx2 < 0 || nx2 >= N || ny2 < 0 || ny2 >= N) continue;
                    var nidx = nx2 + ny2 * N;
                    sum += (snap[nidx] !== undefined ? snap[nidx] : heights[nidx]);
                    cnt++;
                }
            }
            var smoothed = sum / cnt;
            heights[idx] = heights[idx] + (smoothed - heights[idx]) * Math.min(1.0, w * strength);
        });
    };

    /**
     * Set height – stamp the brush to a specific height value, blended by falloff.
     */
    TE.brushSetHeight = function (heights, cx, cy, radius, strength, falloffProfile, targetHeight) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            heights[idx] = heights[idx] + (targetHeight - heights[idx]) * w;
        });
    };

    /**
     * Scale height – multiply heights by a factor, blended by falloff.
     */
    TE.brushScale = function (heights, cx, cy, radius, strength, falloffProfile, scaleFactor) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            var blended = heights[idx] * scaleFactor;
            heights[idx] = Math.max(0, Math.min(HMAX,
                heights[idx] + (blended - heights[idx]) * w * strength
            ));
        });
    };

    /**
     * Noise brush – adds random height perturbations.
     * Uses a seeded LCG so results are stable per position.
     */
    TE.brushNoise = function (heights, cx, cy, radius, strength, falloffProfile) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            // Simple LCG hash for repeatable per-cell randomness
            var h = ((x * 374761393 + y * 668265263) ^ (x << 13) ^ (y << 7)) >>> 0;
            h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
            var rand = (h / 0xFFFFFFFF) * 2.0 - 1.0; // [-1, 1]
            heights[idx] = Math.max(0, Math.min(HMAX,
                heights[idx] + rand * strength * w
            ));
        });
    };

    /**
     * Adjust height (click-drag style, like TGE brushAdjustHeight).
     * delta is positive or negative, controls direction.
     */
    TE.brushAdjust = function (heights, cx, cy, radius, delta, falloffProfile) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            heights[idx] = Math.max(0, Math.min(HMAX, heights[idx] + delta * w));
        });
    };

    /**
     * Slope – fits a best-fit plane to the brush region (least-squares) and blends
     * every cell toward that plane, preserving the existing slope while smoothing
     * out roughness. Makes a clean planar ramp under the brush.
     */
    TE.brushSlope = function (heights, cx, cy, radius, strength, falloffProfile) {
        // Gather cells and weights
        var cells = [];
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            cells.push({ idx: idx, x: x, y: y, h: heights[idx], w: w });
        });
        if (cells.length < 3) return;

        // Compute weighted centroid
        var wSum = 0, xSum = 0, ySum = 0, hSum = 0;
        for (var i = 0; i < cells.length; i++) {
            var ww = cells[i].w;
            wSum += ww;
            xSum += cells[i].x * ww;
            ySum += cells[i].y * ww;
            hSum += cells[i].h * ww;
        }
        var mx = xSum / wSum, my = ySum / wSum, mh = hSum / wSum;

        // Weighted least-squares for plane H = mh + b*(x-mx) + c*(y-my)
        var sxx = 0, sxy = 0, sxh = 0, syy = 0, syh = 0;
        for (var i = 0; i < cells.length; i++) {
            var ww = cells[i].w;
            var dx = cells[i].x - mx, dy = cells[i].y - my;
            var dh = cells[i].h - mh;
            sxx += dx * dx * ww;
            sxy += dx * dy * ww;
            sxh += dx * dh * ww;
            syy += dy * dy * ww;
            syh += dy * dh * ww;
        }
        var det = sxx * syy - sxy * sxy;
        if (Math.abs(det) < 1e-9) return;   // degenerate (all same x or y)
        var b = (syy * sxh - sxy * syh) / det;
        var c = (sxx * syh - sxy * sxh) / det;

        // Blend each cell toward its plane target
        for (var i = 0; i < cells.length; i++) {
            var target = mh + b * (cells[i].x - mx) + c * (cells[i].y - my);
            target = Math.max(0, Math.min(HMAX, target));
            heights[cells[i].idx] += (target - cells[i].h) * Math.min(1.0, cells[i].w * strength);
        }
    };

    /**
     * Smooth entire terrain (global, not brush-based).
     * @param {number} passes  number of passes
     * @param {number} amount  blend factor [0..1]
     */
    TE.smoothAll = function (heights, passes, amount) {
        passes = passes || 1;
        amount = amount !== undefined ? amount : 0.5;
        var temp = new Float32Array(N * N);
        for (var p = 0; p < passes; p++) {
            for (var y = 0; y < N; y++) {
                for (var x = 0; x < N; x++) {
                    var sum = 0, cnt = 0;
                    for (var ky = -1; ky <= 1; ky++) {
                        for (var kx = -1; kx <= 1; kx++) {
                            var nx2 = x + kx, ny2 = y + ky;
                            if (nx2 < 0 || nx2 >= N || ny2 < 0 || ny2 >= N) continue;
                            sum += heights[nx2 + ny2 * N];
                            cnt++;
                        }
                    }
                    var s = sum / cnt;
                    temp[x + y * N] = heights[x + y * N] * (1 - amount) + s * amount;
                }
            }
            for (var i = 0; i < N * N; i++) heights[i] = temp[i];
        }
    };

    /**
     * Flatten entire terrain to a uniform height.
     */
    TE.flattenAll = function (heights, targetH) {
        for (var i = 0; i < N * N; i++) heights[i] = targetH;
    };

    /**
     * Scale entire terrain heights by a factor.
     */
    TE.scaleAll = function (heights, factor) {
        for (var i = 0; i < N * N; i++) {
            heights[i] = Math.max(0, Math.min(HMAX, heights[i] * factor));
        }
    };

    /**
     * Compute basic statistics about the heightmap.
     */
    TE.heightStats = function (heights) {
        var lo = heights[0], hi = heights[0], sum = 0;
        for (var i = 0; i < heights.length; i++) {
            if (heights[i] < lo) lo = heights[i];
            if (heights[i] > hi) hi = heights[i];
            sum += heights[i];
        }
        return {
            min : lo,
            max : hi,
            avg : sum / heights.length,
            range : hi - lo
        };
    };

    /**
     * Compute the falloff weight for a point at distance d from brush centre.
     * Exported so other modules (e.g. terrain3d.js) can colour the brush cursor.
     *
     * @param {number} d        distance from centre
     * @param {number} r        brush radius
     * @param {string} profile  'hard' | 'linear' | 'smooth' | 'gaussian'
     * @returns {number}        weight in [0, 1]
     */
    TE.computeWeight = falloff;

    /**
     * Mirror terrain heights across a line through the terrain centre (128,128).
     *
     * Angle convention – degrees from "vertical" (a vertical line = 0°):
     *   0°   → vertical line  (left / right split)
     *   90°  → horizontal line (top / bottom split)
     *   45°  → diagonal top-left → bottom-right
     *   135° → diagonal top-right → bottom-left
     *
     * Side labelling (A = positive normal side):
     *   0°  → A is left half,   B is right half
     *   90° → A is bottom half, B is top half
     *
     * @param {Float32Array} heights
     * @param {number}  angleDeg   angle of mirror line (0–179)
     * @param {string}  direction  'srcA' – copy A to B (B gets overwritten)
     *                             'srcB' – copy B to A (A gets overwritten)
     * @param {boolean} alsoFlip   when true, also reflect the mirrored side across
     *                             the axis perpendicular to the mirror line, so that
     *                             terrain features appear diagonally opposite each
     *                             other (equivalent to a 180° rotation about centre).
     */
    TE.mirrorTerrain = function (heights, angleDeg, direction, alsoFlip) {
        var cx = N / 2, cy = N / 2;
        var A  = angleDeg * Math.PI / 180;
        var sinA = Math.sin(A), cosA = Math.cos(A);
        // Line direction: (sinA, cosA)
        // Positive normal direction: (-cosA, sinA)
        // Side of point (x,y): side = -cosA*(x-cx) + sinA*(y-cy)
        //   > 0 → side A
        //   < 0 → side B

        var snap = new Float32Array(heights);

        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var dx   = x - cx;
                var dy   = y - cy;
                var side = -cosA * dx + sinA * dy;

                var overwrite = (direction === 'srcA') ? (side < 0) : (side > 0);
                if (!overwrite) continue;

                // Determine the source point using backward mapping (destination is always
                // the current integer pixel (x, y), avoiding forward-map rounding artifacts).
                //
                // Normal mirror: reflect (x,y) across the mirror line.
                // alsoFlip:      mirror + perpendicular-flip == 180° rotation about centre,
                //                so source = (2*cx - x, 2*cy - y).  No fractional destination
                //                means no holes or double-writes at off-axis angles.
                var mx, my;
                if (alsoFlip) {
                    mx = 2 * cx - x;
                    my = 2 * cy - y;
                } else {
                    var proj = dx * sinA + dy * cosA;
                    mx = cx + 2 * proj * sinA - dx;
                    my = cy + 2 * proj * cosA - dy;
                }

                // Bilinear sample from snapshot
                var h;
                if (mx >= 0 && mx <= N - 1 && my >= 0 && my <= N - 1) {
                    var fix = Math.floor(mx), fiy = Math.floor(my);
                    var fx  = mx - fix,       fy  = my - fiy;
                    var xi  = Math.min(fix + 1, N - 1);
                    var yi  = Math.min(fiy + 1, N - 1);
                    h = snap[fix + fiy * N] * (1 - fx) * (1 - fy) +
                        snap[xi  + fiy * N] * fx       * (1 - fy) +
                        snap[fix + yi  * N] * (1 - fx) * fy       +
                        snap[xi  + yi  * N] * fx       * fy;
                } else {
                    var cxi = Math.max(0, Math.min(N - 1, Math.round(mx)));
                    var cyi = Math.max(0, Math.min(N - 1, Math.round(my)));
                    h = snap[cxi + cyi * N];
                }

                heights[x + y * N] = Math.max(0, Math.min(HMAX, h));
            }
        }
    };

    /**
     * Imprint a PNG stencil (as ImageData) onto terrain heights.
     *
     * Stencil brightness (0=black → low, 1=white → full HMAX) drives the height value.
     * The stencil is placed with its top-left corner at (ox, oy) in grid space and scaled.
     *
     * @param {Float32Array} heights
     * @param {ImageData}    stencilData  source ImageData from a canvas
     * @param {number}       ox           X offset in terrain grid cells
     * @param {number}       oy           Y offset in terrain grid cells
     * @param {number}       scale        stencil pixels per terrain cell (e.g. 1.0 = 1:1)
     * @param {number}       strength     blend weight [0..1]
     * @param {string}       mode         'set' | 'add' | 'max' | 'min'
     */
    TE.applyStencil = function (heights, stencilData, ox, oy, scale, strength, mode, rotDeg) {
        var sw = stencilData.width, sh = stencilData.height;
        var rot  = (rotDeg || 0) * Math.PI / 180;
        var cosR = Math.cos(rot), sinR = Math.sin(rot);
        var scx  = sw / 2, scy = sh / 2;   // stencil centre in stencil-pixel space

        for (var ty = 0; ty < N; ty++) {
            for (var tx = 0; tx < N; tx++) {
                var sx, sy;
                if (!rot) {
                    // Fast path: no rotation
                    sx = (tx - ox) / scale;
                    sy = (ty - oy) / scale;
                } else {
                    // Displacement from stencil centre in stencil-pixel space
                    var dx = (tx - ox) / scale - scx;
                    var dy = (ty - oy) / scale - scy;
                    // Counter-rotate to find source pixel in unrotated stencil
                    sx = dx * cosR + dy * sinR + scx;
                    sy = -dx * sinR + dy * cosR + scy;
                }
                if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;

                var six = Math.floor(sx), siy = Math.floor(sy);
                var pi  = (siy * sw + six) * 4;
                // Luminance (Rec.601)
                var brightness = (stencilData.data[pi]     * 0.299 +
                                  stencilData.data[pi + 1] * 0.587 +
                                  stencilData.data[pi + 2] * 0.114) / 255;
                var alpha = stencilData.data[pi + 3] / 255;
                var blend = strength * alpha;
                if (blend < 0.001) continue;

                var idx      = tx + ty * N;
                var stencilH = brightness * HMAX;

                switch (mode) {
                    case 'set':
                        heights[idx] = heights[idx] * (1 - blend) + stencilH * blend;
                        break;
                    case 'add':
                        heights[idx] = heights[idx] + stencilH * blend;
                        break;
                    case 'max':
                        heights[idx] = Math.max(heights[idx], stencilH);
                        break;
                    case 'min':
                        heights[idx] = Math.min(heights[idx], stencilH);
                        break;
                    default:
                        heights[idx] = heights[idx] * (1 - blend) + stencilH * blend;
                }
                heights[idx] = Math.max(0, Math.min(HMAX, heights[idx]));
            }
        }
    };

    /**
     * Normalise heights to a [minH, maxH] range.
     */
    TE.normaliseHeights = function (heights, minH, maxH) {
        var lo = heights[0], hi = heights[0];
        for (var i = 1; i < heights.length; i++) {
            if (heights[i] < lo) lo = heights[i];
            if (heights[i] > hi) hi = heights[i];
        }
        var range = hi - lo;
        var outRange = maxH - minH;
        for (var j = 0; j < heights.length; j++) {
            heights[j] = range < 1e-6
                ? minH
                : minH + ((heights[j] - lo) / range) * outRange;
        }
    };

    /**
     * Edge Smooth – makes the terrain tile seamlessly by cross-blending each edge
     * with its opposing edge.  Within `margin` cells of the left/right edges both
     * pixels (and their horizontal mirrors) are averaged together; the same is then
     * done for the top/bottom edges.  The result is that heights[0,y] == heights[N-1,y]
     * and heights[x,0] == heights[x,N-1] so placed tiles share no visible seam.
     *
     * @param {Float32Array} heights
     * @param {number}       margin  width of the blend zone in grid cells (4–64)
     */
    TE.edgeSmooth = function (heights, margin) {
        margin = Math.max(1, Math.min(Math.floor(N / 2) - 1, Math.round(margin)));

        // Pass 1 – blend left↔right edges
        var tmp = new Float32Array(heights);
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < margin; x++) {
                var mx = N - 1 - x;
                // t: 0 at the outermost edge cell, 1 at the inner boundary of the margin
                var t   = x / margin;
                t = t * t * (3 - 2 * t);          // smooth-step
                var a   = tmp[x  + y * N];
                var b   = tmp[mx + y * N];
                var avg = (a + b) * 0.5;
                heights[x  + y * N] = Math.max(0, Math.min(HMAX, avg + t * (a - avg)));
                heights[mx + y * N] = Math.max(0, Math.min(HMAX, avg + t * (b - avg)));
            }
        }

        // Pass 2 – blend top↔bottom edges (reading pass-1 result)
        tmp = new Float32Array(heights);
        for (var y2 = 0; y2 < margin; y2++) {
            var my = N - 1 - y2;
            for (var x2 = 0; x2 < N; x2++) {
                var t2  = y2 / margin;
                t2 = t2 * t2 * (3 - 2 * t2);
                var c   = tmp[x2 + y2 * N];
                var d   = tmp[x2 + my * N];
                var avg2 = (c + d) * 0.5;
                heights[x2 + y2 * N] = Math.max(0, Math.min(HMAX, avg2 + t2 * (c - avg2)));
                heights[x2 + my * N] = Math.max(0, Math.min(HMAX, avg2 + t2 * (d - avg2)));
            }
        }
    };

    /**
     * Toroidal scroll: shift all terrain heights by (shiftX, shiftY) grid cells,
     * wrapping at the edges. Reads from `snapshot` (a frozen copy) and writes to
     * `heights` so repeated calls with different shifts are idempotent.
     *
     * Positive shiftX moves content to the right (east), positive shiftY moves
     * content downward (south).
     *
     * @param {Float32Array} heights   destination array (modified in-place)
     * @param {Float32Array} snapshot  unmodified source snapshot
     * @param {number}       shiftX   integer cell shift in X (can be negative)
     * @param {number}       shiftY   integer cell shift in Y (can be negative)
     */
    TE.scrollTerrain = function (heights, snapshot, shiftX, shiftY) {
        shiftX = ((Math.round(shiftX) % N) + N) % N;
        shiftY = ((Math.round(shiftY) % N) + N) % N;
        for (var y = 0; y < N; y++) {
            var srcY = (y - shiftY + N) % N;
            for (var x = 0; x < N; x++) {
                var srcX = (x - shiftX + N) % N;
                heights[x + y * N] = snapshot[srcX + srcY * N];
            }
        }
    };

    /**
     * Flip terrain heights horizontally (left↔right) or vertically (top↔bottom).
     * @param {Float32Array} heights
     * @param {string} axis  'h' = horizontal (left↔right), 'v' = vertical (top↔bottom)
     */
    TE.flipHeights = function (heights, axis) {
        var snap = new Float32Array(heights);
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var srcX = (axis === 'h') ? (N - 1 - x) : x;
                var srcY = (axis === 'v') ? (N - 1 - y) : y;
                heights[x + y * N] = snap[srcX + srcY * N];
            }
        }
    };

    /**
     * Rotate terrain heights 90 degrees clockwise ('cw') or counter-clockwise ('ccw').
     * @param {Float32Array} heights
     * @param {string} dir  'cw' | 'ccw'
     */
    TE.rotateHeights = function (heights, dir) {
        var snap = new Float32Array(heights);
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var srcX, srcY;
                if (dir === 'cw') {
                    // 90° CW: new (x,y) reads from old (y, N-1-x)
                    srcX = y;
                    srcY = N - 1 - x;
                } else {
                    // 90° CCW: new (x,y) reads from old (N-1-y, x)
                    srcX = N - 1 - y;
                    srcY = x;
                }
                heights[x + y * N] = snap[srcX + srcY * N];
            }
        }
    };

    /**
     * Twist – rotates height values radially around the brush centre.
     * Each cell is displaced around the centre by an angle proportional to
     * its falloff weight × strength. Uses bilinear sampling from a snapshot
     * so the result is stable regardless of write order.
     */
    TE.brushTwist = function (heights, cx, cy, radius, strength, falloffProfile) {
        var snap = new Float32Array(heights);
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            var dx    = x - cx, dy = y - cy;
            var angle = w * strength * 0.015;  // radians; strength=5 → ~4° at centre
            var cosA  = Math.cos(angle), sinA = Math.sin(angle);
            var srcX  = cx + dx * cosA - dy * sinA;
            var srcY  = cy + dx * sinA + dy * cosA;

            // Bilinear sample from snapshot, clamped to grid bounds
            srcX = Math.max(0, Math.min(N - 1.001, srcX));
            srcY = Math.max(0, Math.min(N - 1.001, srcY));
            var ix = Math.floor(srcX), iy = Math.floor(srcY);
            var tx = srcX - ix,        ty2 = srcY - iy;
            var xi = Math.min(ix + 1, N - 1);
            var yi = Math.min(iy + 1, N - 1);
            var h  = snap[ix + iy * N] * (1 - tx) * (1 - ty2) +
                     snap[xi + iy * N] *      tx  * (1 - ty2) +
                     snap[ix + yi * N] * (1 - tx) *      ty2  +
                     snap[xi + yi * N] *      tx  *      ty2;
            heights[idx] = Math.max(0, Math.min(HMAX, h));
        });
    };

    /**
     * Stamp a PNG image centred at (cx, cy) in terrain grid space with optional rotation.
     * Unlike applyStencil (which uses a top-left offset), the position here is the
     * centre of the stamp, making it easier to place precisely.
     *
     * @param {Float32Array} heights
     * @param {ImageData}    stencilData  source image data
     * @param {number}       cx           X centre in terrain grid cells
     * @param {number}       cy           Y centre in terrain grid cells
     * @param {number}       scale        terrain cells per stencil pixel
     * @param {number}       rotDeg       clockwise rotation in degrees
     * @param {number}       strength     blend weight [0..1]
     * @param {string}       mode         'set' | 'add' | 'max' | 'min'
     */
    TE.applyStamp = function (heights, stencilData, cx, cy, scale, rotDeg, strength, mode) {
        var sw   = stencilData.width, sh = stencilData.height;
        var rot  = (rotDeg || 0) * Math.PI / 180;
        var cosR = Math.cos(rot), sinR = Math.sin(rot);

        for (var ty = 0; ty < N; ty++) {
            for (var tx = 0; tx < N; tx++) {
                // Displacement from stamp centre in stencil-pixel space
                var dx = (tx - cx) / scale;
                var dy = (ty - cy) / scale;
                // Counter-rotate to find source pixel in the unrotated stencil
                var sx = dx * cosR + dy * sinR + sw / 2;
                var sy = -dx * sinR + dy * cosR + sh / 2;

                if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;

                var six = Math.floor(sx), siy = Math.floor(sy);
                var pi  = (siy * sw + six) * 4;
                var brightness = (stencilData.data[pi]     * 0.299 +
                                  stencilData.data[pi + 1] * 0.587 +
                                  stencilData.data[pi + 2] * 0.114) / 255;
                var alpha = stencilData.data[pi + 3] / 255;
                var blend = strength * alpha;
                if (blend < 0.001) continue;

                var idx      = tx + ty * N;
                var stencilH = brightness * HMAX;

                switch (mode) {
                    case 'set':
                        heights[idx] = heights[idx] * (1 - blend) + stencilH * blend;
                        break;
                    case 'add':
                        heights[idx] = heights[idx] + stencilH * blend;
                        break;
                    case 'max':
                        heights[idx] = Math.max(heights[idx], stencilH);
                        break;
                    case 'min':
                        heights[idx] = Math.min(heights[idx], stencilH);
                        break;
                    default:
                        heights[idx] = heights[idx] * (1 - blend) + stencilH * blend;
                }
                heights[idx] = Math.max(0, Math.min(HMAX, heights[idx]));
            }
        }
    };

    /**
     * Paint alpha values into a terrain alpha map at a brush position.
     * Positive value paints (increases alpha toward 255); negative erases (toward 0).
     *
     * @param {Uint8Array} alphaMap     256×256 alpha map (0–255)
     * @param {number} cx, cy           brush centre in grid cells
     * @param {number} radius           brush radius in cells
     * @param {number} value            amount to add per stroke (+= paint, -= erase)
     * @param {string} falloffProfile
     */
    TE.paintAlpha = function (alphaMap, cx, cy, radius, value, falloffProfile) {
        eachCell(cx, cy, radius, falloffProfile, function (idx, x, y, w) {
            alphaMap[idx] = Math.max(0, Math.min(255, Math.round(alphaMap[idx] + value * w)));
        });
    };

    /**
     * Auto-paint a texture alpha layer based on terrain altitude.
     * Cells in [minH, maxH] are fully painted (alpha → 255); the transition is
     * smoothly feathered over blendWidth metres beyond the band edges.
     *
     * @param {Uint8Array}   alphaMap
     * @param {Float32Array} heights
     * @param {number} minH         lower bound of fully-painted altitude (metres)
     * @param {number} maxH         upper bound of fully-painted altitude (metres)
     * @param {number} blendWidth   feather distance in metres beyond min/max
     * @param {number} strength     overall blend factor [0..1]
     */
    TE.autoPaintByAltitude = function (alphaMap, heights, minH, maxH, blendWidth, strength) {
        blendWidth = Math.max(0.1, blendWidth);
        for (var i = 0; i < N * N; i++) {
            var h = heights[i];
            var t;
            if (h < minH - blendWidth || h > maxH + blendWidth) {
                t = 0;
            } else if (h >= minH && h <= maxH) {
                t = 1;
            } else if (h < minH) {
                t = (h - (minH - blendWidth)) / blendWidth;
            } else {
                t = 1 - (h - maxH) / blendWidth;
            }
            t = Math.max(0, Math.min(1, t * t * (3 - 2 * t)));  // smooth-step
            var target = Math.round(t * 255);
            alphaMap[i] = Math.max(0, Math.min(255,
                Math.round(alphaMap[i] + (target - alphaMap[i]) * strength)));
        }
    };

    /**
     * Auto-paint a texture alpha layer based on terrain slope angle.
     * Slope is computed per-cell from the gradient magnitude (degrees: 0=flat, 90=cliff).
     * TGE cell size is 8 world units; this matches TE.SCALE in terrain3d.js.
     *
     * @param {Uint8Array}   alphaMap
     * @param {Float32Array} heights
     * @param {number} minSlope     lower bound of fully-painted slope (degrees)
     * @param {number} maxSlope     upper bound of fully-painted slope (degrees)
     * @param {number} blendWidth   feather in degrees beyond min/max
     * @param {number} strength     overall blend factor [0..1]
     */
    TE.autoPaintBySlope = function (alphaMap, heights, minSlope, maxSlope, blendWidth, strength) {
        var CELL = 8;   // TGE world units (metres) per grid cell — matches TE.SCALE
        blendWidth = Math.max(0.1, blendWidth);
        for (var y = 0; y < N; y++) {
            for (var x = 0; x < N; x++) {
                var xl = Math.max(0, x - 1), xr = Math.min(N - 1, x + 1);
                var yl = Math.max(0, y - 1), yr = Math.min(N - 1, y + 1);
                var dzdx = (heights[xr + y * N] - heights[xl + y * N]) / ((xr - xl) * CELL);
                var dzdy = (heights[x + yr * N] - heights[x + yl * N]) / ((yr - yl) * CELL);
                var slopeDeg = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * 180 / Math.PI;

                var t;
                if (slopeDeg < minSlope - blendWidth || slopeDeg > maxSlope + blendWidth) {
                    t = 0;
                } else if (slopeDeg >= minSlope && slopeDeg <= maxSlope) {
                    t = 1;
                } else if (slopeDeg < minSlope) {
                    t = (slopeDeg - (minSlope - blendWidth)) / blendWidth;
                } else {
                    t = 1 - (slopeDeg - maxSlope) / blendWidth;
                }
                t = Math.max(0, Math.min(1, t * t * (3 - 2 * t)));
                var target = Math.round(t * 255);
                var idx = x + y * N;
                alphaMap[idx] = Math.max(0, Math.min(255,
                    Math.round(alphaMap[idx] + (target - alphaMap[idx]) * strength)));
            }
        }
    };

    window.TerEdit = TE;

}(TerEdit));
