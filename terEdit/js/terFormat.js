/**
 * terFormat.js
 * TGE .ter file format parser and serializer.
 *
 * Format (version 3):
 *   U8               version (== 3)
 *   U16[256*256]     heightmap, little-endian, 11.5 fixed-point (val * 0.03125 = metres)
 *   U8[256*256]      baseMaterialMap  (low 3 bits = group 0-7, bit 7 = PersistMask)
 *   8 × pascal-str   material filenames (1-byte length + content)
 *   U8[256*256] × N  alpha maps for each group whose filename is non-empty
 *   U32 + bytes      texture script (little-endian length)
 *   U32 + bytes      heightfield script
 */

/* global TerEdit */
var TerEdit = window.TerEdit || {};

(function (TE) {
    'use strict';

    var BLOCK       = 256;
    var FILE_VER    = 3;
    var MAT_GROUPS  = 8;
    var GROUP_MASK  = 0x07;
    var PERSIST_BIT = 0x80;
    var H_SCALE     = 0.03125;   // u16 → metres
    var H_INV       = 32.0;      // metres → u16

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Parse a .ter ArrayBuffer into a terrain object.
     * heights[] is Float32Array in metres; all other arrays use the TGE layout.
     */
    TE.parseTerFile = function (buffer) {
        var view   = new DataView(buffer);
        var offset = 0;
        var n      = BLOCK * BLOCK;

        var version = view.getUint8(offset++);
        if (version > FILE_VER) {
            throw new Error('Unsupported .ter version: ' + version);
        }

        // Heightmap
        var heightMapU16 = new Uint16Array(n);
        for (var i = 0; i < n; i++) {
            heightMapU16[i] = view.getUint16(offset, true);
            offset += 2;
        }

        // Material group map
        var baseMaterialMap = new Uint8Array(n);
        var materialFlags   = new Uint8Array(n);
        for (var i = 0; i < n; i++) {
            var val = view.getUint8(offset++);
            baseMaterialMap[i] = val & GROUP_MASK;
            materialFlags[i]   = val & PERSIST_BIT;
        }

        // Material filenames – pascal strings (1-byte length)
        var materialFileNames = [];
        for (var k = 0; k < MAT_GROUPS; k++) {
            var len  = view.getUint8(offset++);
            var name = '';
            for (var c = 0; c < len; c++) {
                name += String.fromCharCode(view.getUint8(offset++));
            }
            materialFileNames.push(name);
        }

        // Alpha maps – one 256×256 block per non-empty material slot
        var materialAlphaMaps = new Array(MAT_GROUPS).fill(null);
        if (version >= 2) {
            for (var k = 0; k < MAT_GROUPS; k++) {
                if (materialFileNames[k] && materialFileNames[k].length > 0) {
                    if (offset + n <= buffer.byteLength) {
                        materialAlphaMaps[k] = new Uint8Array(buffer.slice(offset, offset + n));
                        offset += n;
                    }
                }
            }
        }

        // Scripts (version 3+)
        var textureScript     = '';
        var heightfieldScript = '';
        if (version >= 3) {
            if (offset + 4 <= buffer.byteLength) {
                var tLen = view.getUint32(offset, true); offset += 4;
                if (tLen > 0 && offset + tLen <= buffer.byteLength) {
                    textureScript = new TextDecoder().decode(new Uint8Array(buffer, offset, tLen));
                    offset += tLen;
                }
            }
            if (offset + 4 <= buffer.byteLength) {
                var hLen = view.getUint32(offset, true); offset += 4;
                if (hLen > 0 && offset + hLen <= buffer.byteLength) {
                    heightfieldScript = new TextDecoder().decode(new Uint8Array(buffer, offset, hLen));
                    offset += hLen;
                }
            }
        }

        // Convert U16 → float metres
        var heights = new Float32Array(n);
        for (var i = 0; i < n; i++) {
            heights[i] = heightMapU16[i] * H_SCALE;
        }

        return {
            version           : version,
            heights           : heights,
            baseMaterialMap   : baseMaterialMap,
            materialFlags     : materialFlags,
            materialFileNames : materialFileNames,
            materialAlphaMaps : materialAlphaMaps,
            textureScript     : textureScript,
            heightfieldScript : heightfieldScript
        };
    };

    /**
     * Serialize a terrain object back to a .ter ArrayBuffer.
     * Always writes FILE_VER (3).
     */
    TE.serializeTerFile = function (terrain) {
        var n = BLOCK * BLOCK;

        var heights           = terrain.heights           || new Float32Array(n);
        var baseMaterialMap   = terrain.baseMaterialMap   || new Uint8Array(n);
        var materialFlags     = terrain.materialFlags     || new Uint8Array(n);
        var materialAlphaMaps = terrain.materialAlphaMaps || new Array(MAT_GROUPS).fill(null);
        var textureScript     = terrain.textureScript     || '';
        var heightfieldScript = terrain.heightfieldScript || '';

        // Normalise filenames array to exactly 8 entries
        var names = (terrain.materialFileNames || []).slice();
        while (names.length < MAT_GROUPS) names.push('');
        names = names.slice(0, MAT_GROUPS);

        // Calculate buffer size
        var size = 1;                       // version
        size += n * 2;                      // U16 heightmap
        size += n;                          // material map
        for (var k = 0; k < MAT_GROUPS; k++) {
            size += 1 + (names[k] ? names[k].length : 0);  // pascal string
        }
        for (var k = 0; k < MAT_GROUPS; k++) {
            if (names[k] && names[k].length > 0 && materialAlphaMaps[k]) {
                size += n;
            }
        }
        size += 4 + textureScript.length;
        size += 4 + heightfieldScript.length;

        var buf    = new ArrayBuffer(size);
        var view   = new DataView(buf);
        var offset = 0;

        // Version
        view.setUint8(offset++, FILE_VER);

        // Heightmap
        for (var i = 0; i < n; i++) {
            var u16 = Math.max(0, Math.min(65535, Math.round(heights[i] * H_INV)));
            view.setUint16(offset, u16, true);
            offset += 2;
        }

        // Material map
        for (var i = 0; i < n; i++) {
            var v = (baseMaterialMap[i] & GROUP_MASK) | (materialFlags[i] & PERSIST_BIT);
            view.setUint8(offset++, v);
        }

        // Material filenames (pascal strings)
        for (var k = 0; k < MAT_GROUPS; k++) {
            var name = names[k] || '';
            view.setUint8(offset++, name.length);
            for (var c = 0; c < name.length; c++) {
                view.setUint8(offset++, name.charCodeAt(c));
            }
        }

        // Alpha maps
        for (var k = 0; k < MAT_GROUPS; k++) {
            if (names[k] && names[k].length > 0 && materialAlphaMaps[k]) {
                var am = materialAlphaMaps[k];
                for (var i = 0; i < n; i++) {
                    view.setUint8(offset++, am[i]);
                }
            }
        }

        // Texture script
        view.setUint32(offset, textureScript.length, true); offset += 4;
        for (var c = 0; c < textureScript.length; c++) {
            view.setUint8(offset++, textureScript.charCodeAt(c));
        }

        // Heightfield script
        view.setUint32(offset, heightfieldScript.length, true); offset += 4;
        for (var c = 0; c < heightfieldScript.length; c++) {
            view.setUint8(offset++, heightfieldScript.charCodeAt(c));
        }

        return buf;
    };

    /**
     * Create a brand-new flat terrain object (all heights = 0).
     */
    TE.createEmptyTerrain = function () {
        var n = BLOCK * BLOCK;
        return {
            version           : FILE_VER,
            heights           : new Float32Array(n),
            baseMaterialMap   : new Uint8Array(n),
            materialFlags     : new Uint8Array(n),
            materialFileNames : new Array(MAT_GROUPS).fill(''),
            materialAlphaMaps : new Array(MAT_GROUPS).fill(null),
            textureScript     : '',
            heightfieldScript : ''
        };
    };

    /**
     * Deep-clone terrain data.
     */
    TE.cloneTerrain = function (t) {
        return {
            version           : t.version,
            heights           : new Float32Array(t.heights),
            baseMaterialMap   : new Uint8Array(t.baseMaterialMap),
            materialFlags     : new Uint8Array(t.materialFlags),
            materialFileNames : t.materialFileNames.slice(),
            materialAlphaMaps : t.materialAlphaMaps.map(function (m) {
                return m ? new Uint8Array(m) : null;
            }),
            textureScript     : t.textureScript,
            heightfieldScript : t.heightfieldScript
        };
    };

    TE.BLOCK      = BLOCK;
    TE.MAT_GROUPS = MAT_GROUPS;
    TE.H_SCALE    = H_SCALE;
    TE.SCALE      = 8; // world units per grid cell
    TE.HMAX       = 65535 * H_SCALE; // maximum terrain height in metres (≈ 2047.97)

    window.TerEdit = TE;

}(TerEdit));
