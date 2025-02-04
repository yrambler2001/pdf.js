/* Copyright 2024 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BaseException, warn } from "../shared/util.js";
import { fetchBinaryData } from "./core_utils.js";
import OpenJPEG from "../../external/openjpeg/openjpeg.js";
import { Stream } from "./stream.js";

class JpxError extends BaseException {
  constructor(msg) {
    super(msg, "JpxError");
  }
}

class JpxImage {
  static #buffer = null;

  static #handler = null;

  static #modulePromise = null;

  static #wasmUrl = null;

  static setOptions({ handler, wasmUrl }) {
    if (!this.#buffer) {
      this.#wasmUrl = wasmUrl || null;
      if (wasmUrl === null) {
        this.#handler = handler;
      }
    }
  }

  static async #instantiateWasm(imports, successCallback) {
    const filename = "openjpeg.wasm";
    try {
      if (!this.#buffer) {
        if (this.#wasmUrl !== null) {
          this.#buffer = await fetchBinaryData(`${this.#wasmUrl}${filename}`);
        } else {
          this.#buffer = await this.#handler.sendWithPromise("FetchWasm", {
            filename,
          });
        }
      }
      const results = await WebAssembly.instantiate(this.#buffer, imports);
      return successCallback(results.instance);
    } finally {
      this.#handler = null;
      this.#wasmUrl = null;
    }
  }

  static async decode(
    bytes,
    { numComponents = 4, isIndexedColormap = false, smaskInData = false } = {}
  ) {
    this.#modulePromise ||= OpenJPEG({
      warn,
      instantiateWasm: this.#instantiateWasm.bind(this),
    });

    const module = await this.#modulePromise;
    let ptr;

    try {
      const size = bytes.length;
      ptr = module._malloc(size);
      module.HEAPU8.set(bytes, ptr);
      const ret = module._jp2_decode(
        ptr,
        size,
        numComponents > 0 ? numComponents : 0,
        !!isIndexedColormap,
        !!smaskInData
      );
      if (ret) {
        const { errorMessages } = module;
        if (errorMessages) {
          delete module.errorMessages;
          throw new JpxError(errorMessages);
        }
        throw new JpxError("Unknown error");
      }
      const { imageData } = module;
      module.imageData = null;

      return imageData;
    } finally {
      if (ptr) {
        module._free(ptr);
      }
    }
  }

  static cleanup() {
    this.#modulePromise = null;
  }

  static parseImageProperties(stream) {
    if (typeof PDFJSDev !== "undefined" && PDFJSDev.test("IMAGE_DECODERS")) {
      if (stream instanceof ArrayBuffer || ArrayBuffer.isView(stream)) {
        stream = new Stream(stream);
      } else {
        throw new JpxError("Invalid data format, must be a TypedArray.");
      }
    }
    // No need to use OpenJPEG here since we're only getting very basic
    // information which are located in the first bytes of the file.
    let newByte = stream.getByte();
    while (newByte >= 0) {
      const oldByte = newByte;
      newByte = stream.getByte();
      const code = (oldByte << 8) | newByte;
      // Image and tile size (SIZ)
      if (code === 0xff51) {
        stream.skip(4);
        const Xsiz = stream.getInt32() >>> 0; // Byte 4
        const Ysiz = stream.getInt32() >>> 0; // Byte 8
        const XOsiz = stream.getInt32() >>> 0; // Byte 12
        const YOsiz = stream.getInt32() >>> 0; // Byte 16
        stream.skip(16);
        const Csiz = stream.getUint16(); // Byte 36
        return {
          width: Xsiz - XOsiz,
          height: Ysiz - YOsiz,
          // Results are always returned as `Uint8ClampedArray`s.
          bitsPerComponent: 8,
          componentsCount: Csiz,
        };
      }
    }
    throw new JpxError("No size marker found in JPX stream");
  }
}

export { JpxError, JpxImage };
