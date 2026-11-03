/*!
 * Ecctrl
 * https://github.com/pmndrs/ecctrl
 *
 * SPDX-FileCopyrightText: 2023-2026 Erdong Chen
 * SPDX-License-Identifier: MIT
 */

import { FileLoader, type Group, Loader, type LoadingManager, type Object3D } from "three";
import { unzipSync } from "three/examples/jsm/libs/fflate.module.js";
// @ts-expect-error -- Three.js USD submodule JS lacks bundled .d.ts in @types/three
import { USDAParser as RawUSDAParser } from "three/examples/jsm/loaders/usd/USDAParser.js";
// @ts-expect-error -- Three.js USD submodule JS lacks bundled .d.ts in @types/three
import { USDCParser as RawUSDCParser } from "three/examples/jsm/loaders/usd/USDCParser.js";
// @ts-expect-error -- Three.js USD submodule JS lacks bundled .d.ts in @types/three
import { USDComposer as RawUSDComposer } from "three/examples/jsm/loaders/usd/USDComposer.js";
import { useLoader } from "@react-three/fiber";
import { extractSimReadyPhysics } from "./extractSimReadyPhysics";
import type {
  ExtractSimReadyOptions,
  SimReadyUSDAsset,
  USDSpecEntry,
  USDSpecsByPath,
} from "./types";

interface InternalUSDAParser {
  parseData(text: string): { specsByPath: USDSpecsByPath };
  _extractPrimData(
    data: Record<string, unknown>,
    path: string,
    primFields: Record<string, unknown>,
    specsByPath: USDSpecsByPath,
    SpecType: { Attribute: number; Prim: number; Relationship: number }
  ): void;
  _parseAttributeValue(valueType: string, rawValue: unknown): unknown;
}

interface InternalUSDCParser {
  reader: {
    readUint8(): number;
    readUint32(): number;
    readUint64(): number;
  };
  tokens: string[];
  parseData(buffer: ArrayBuffer): { specsByPath: USDSpecsByPath };
  _readScalarValue(type: number): unknown;
}

interface InternalUSDComposer {
  compose(
    parsedData: { specsByPath: USDSpecsByPath },
    assets?: Record<string, unknown>,
    variantSelections?: Record<string, string>,
    basePath?: string
  ): Group;
}

const TypedUSDAParser = RawUSDAParser as unknown as new () => InternalUSDAParser;
const TypedUSDCParser = RawUSDCParser as unknown as new () => InternalUSDCParser;
const TypedUSDComposer = RawUSDComposer as unknown as new (
  manager?: LoadingManager | null
) => InternalUSDComposer;

const CRATE_TYPE_TOKEN_LIST_OP = 32;
const SPEC_TYPE_ATTRIBUTE = 1;
const SPEC_TYPE_PRIM = 6;
const SPEC_TYPE_RELATIONSHIP = 8;

const API_SCHEMA_KEY_REGEX = /^(?:(?:prepend|append|add|explicit)\s+)?apiSchemas$/;
const REL_KEY_REGEX = /^(?:(?:prepend|append|add|custom)\s+)*rel\s+(.+)$/;

function parseBracketedStrings(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((v) => String(v).trim().replace(/^["'<]|["'>]$/g, ""))
      .filter(Boolean);
  }
  const cleaned = String(raw).trim().replace(/^\[|\]$/g, "");
  if (!cleaned) return [];
  return cleaned
    .split(",")
    .map((s) => s.trim().replace(/^["'<]|["'>]$/g, ""))
    .filter(Boolean);
}

/**
 * Extends Three.js's pure-JS `USDCParser` to decode `TokenListOp` (`type === 32`),
 * preserving `apiSchemas` (`PhysicsRigidBodyAPI`, `PhysicsCollisionAPI`, `PhysicsMassAPI`,
 * `SemanticsAPI`, etc.) inside binary Crate (`.usdc`) files without WASM or `SharedArrayBuffer`.
 */
class SimReadyUSDCParser extends TypedUSDCParser {
  override _readScalarValue(type: number): unknown {
    if (type === CRATE_TYPE_TOKEN_LIST_OP) {
      // AOUSD Core Spec 16.3.10.25 ListOp bitmask layout
      const reader = this.reader;
      const flags = reader.readUint8();
      const hasExplicit = (flags & 0x02) !== 0;
      const hasAdd = (flags & 0x04) !== 0;
      const hasDelete = (flags & 0x08) !== 0;
      const hasReorder = (flags & 0x10) !== 0;
      const hasPrepend = (flags & 0x20) !== 0;
      const hasAppend = (flags & 0x40) !== 0;

      const readTokenList = (): string[] => {
        const count = reader.readUint64();
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          const idx = reader.readUint32();
          out.push(this.tokens[idx] || "");
        }
        return out;
      };

      const explicitItems = hasExplicit ? readTokenList() : [];
      const addItems = hasAdd ? readTokenList() : [];
      const prependItems = hasPrepend ? readTokenList() : [];
      const appendItems = hasAppend ? readTokenList() : [];
      const deleteItems = hasDelete ? readTokenList() : [];
      if (hasReorder) readTokenList();

      const deleteSet = new Set(deleteItems);
      const combined = [
        ...prependItems,
        ...explicitItems,
        ...addItems,
        ...appendItems,
      ].filter((t) => t && !deleteSet.has(t));

      return Array.from(new Set(combined));
    }

    return super._readScalarValue(type);
  }
}

/**
 * Extends Three.js's `USDAParser` to decode `bool` attributes as booleans,
 * preserve `kilogramsPerUnit` on the stage root, and parse `apiSchemas` & multi-target `rel`
 * declarations used by OpenUSD `UsdPhysics` and SimReady schemas.
 */
class SimReadyUSDAParser extends TypedUSDAParser {
  override parseData(text: string): { specsByPath: USDSpecsByPath } {
    const parsed = super.parseData(text) as { specsByPath: USDSpecsByPath };
    const kgMatch = text.match(/kilogramsPerUnit\s*=\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (kgMatch && parsed.specsByPath["/"]) {
      parsed.specsByPath["/"].fields.kilogramsPerUnit = parseFloat(kgMatch[1]);
    }
    return parsed;
  }

  override _extractPrimData(
    data: Record<string, unknown>,
    path: string,
    primFields: Record<string, unknown>,
    specsByPath: USDSpecsByPath,
    SpecType: { Attribute: number; Prim: number; Relationship: number }
  ): void {
    if (!data || typeof data !== "object") return;

    const passthrough: Record<string, unknown> = {};
    const collectedSchemas: string[] = Array.isArray(primFields.apiSchemas)
      ? [...(primFields.apiSchemas as string[])]
      : [];

    for (const key of Object.keys(data)) {
      if (API_SCHEMA_KEY_REGEX.test(key)) {
        collectedSchemas.push(...parseBracketedStrings(data[key]));
        continue;
      }

      const relMatch = key.match(REL_KEY_REGEX);
      if (relMatch) {
        const relName = relMatch[1].trim();
        const relPath = path + "." + relName;
        const targets = parseBracketedStrings(data[key]);
        specsByPath[relPath] = {
          specType: SpecType.Relationship,
          fields: { targetPaths: targets },
        };
        continue;
      }

      // Support prepend/add/explicit references in addition to `prepend references`
      if (
        key === "references" ||
        key === "add references" ||
        key === "append references"
      ) {
        primFields.references = parseBracketedStrings(data[key]);
        continue;
      }

      passthrough[key] = data[key];
    }

    if (collectedSchemas.length > 0) {
      primFields.apiSchemas = Array.from(new Set(collectedSchemas));
    }

    super._extractPrimData(passthrough, path, primFields, specsByPath, SpecType);
  }

  override _parseAttributeValue(valueType: string, rawValue: unknown): unknown {
    if (valueType === "bool") {
      const s = String(rawValue ?? "").trim().toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
    }
    return super._parseAttributeValue(valueType, rawValue);
  }
}

function isCrateBuffer(buffer: ArrayBuffer | Uint8Array): boolean {
  const header = [0x50, 0x58, 0x52, 0x2d, 0x55, 0x53, 0x44, 0x43]; // "PXR-USDC"
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (view.byteLength < header.length) return false;
  for (let i = 0; i < header.length; i++) {
    if (view[i] !== header[i]) return false;
  }
  return true;
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer;
  }
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
}

function getLowercaseExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return "";
  const lastSlash = filename.lastIndexOf("/");
  if (lastSlash > lastDot) return "";
  return filename.slice(lastDot + 1).toLowerCase();
}

function resolveArchivePath(refPath: string, basePath: string): string {
  let clean = refPath.trim();
  if (clean.startsWith("./")) clean = clean.slice(2);
  if (!basePath) return clean;
  const combined = basePath + "/" + clean;
  const parts = combined.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

/**
 * Merges referenced sublayer specs (e.g. inside a `.usdz` package) under their referencing
 * stage prim paths while preserving stronger local overrides on the referencing stage.
 */
function mergeReferencedSpecs(
  rootSpecs: USDSpecsByPath,
  sublayerSpecs: Record<string, USDSpecsByPath>,
  basePath: string
): USDSpecsByPath {
  const merged: USDSpecsByPath = {};
  for (const [k, v] of Object.entries(rootSpecs)) {
    merged[k] = {
      specType: v.specType,
      fields: { ...v.fields },
    };
  }

  for (const primPath of Object.keys(rootSpecs)) {
    const spec = rootSpecs[primPath];
    if (!spec || spec.specType !== SPEC_TYPE_PRIM || primPath === "/") continue;

    const rawRefs: unknown[] = [];
    if (Array.isArray(spec.fields.references)) rawRefs.push(...spec.fields.references);
    else if (spec.fields.references) rawRefs.push(spec.fields.references);
    if (Array.isArray(spec.fields.payload)) rawRefs.push(...spec.fields.payload);
    else if (spec.fields.payload) rawRefs.push(spec.fields.payload);

    for (const rawRef of rawRefs) {
      let filePath = "";
      let targetPrim = "";

      if (typeof rawRef === "string") {
        const match = rawRef.match(/@([^@]+)@(?:<([^>]+)>)?/);
        if (match) {
          filePath = match[1];
          targetPrim = match[2] || "";
        }
      } else if (rawRef && typeof rawRef === "object") {
        const refObj = rawRef as { assetPath?: string; primPath?: string };
        filePath = refObj.assetPath || "";
        targetPrim = refObj.primPath || "";
      }

      if (!filePath) continue;
      const resolvedFile = resolveArchivePath(filePath, basePath);
      const refSpecs = sublayerSpecs[resolvedFile];
      if (!refSpecs) continue;

      let sourceRoot = targetPrim;
      if (!sourceRoot) {
        const defPrim = refSpecs["/"]?.fields?.defaultPrim;
        if (typeof defPrim === "string" && defPrim) {
          sourceRoot = "/" + defPrim.replace(/^\//, "");
        } else {
          const firstChild = Object.keys(refSpecs).find(
            (p) =>
              p !== "/" &&
              refSpecs[p].specType === SPEC_TYPE_PRIM &&
              p.indexOf("/", 1) === -1
          );
          sourceRoot = firstChild || "";
        }
      }
      if (!sourceRoot) continue;

      for (const [refPath, refEntry] of Object.entries(refSpecs)) {
        if (
          refPath !== sourceRoot &&
          !refPath.startsWith(sourceRoot + "/") &&
          !refPath.startsWith(sourceRoot + ".")
        ) {
          continue;
        }

        const suffix = refPath.slice(sourceRoot.length);
        const mappedPath = primPath + suffix;

        let clonedEntry: USDSpecEntry = {
          specType: refEntry.specType,
          fields: { ...refEntry.fields },
        };

        // Re-root internal relationship target paths
        if (
          refEntry.specType === SPEC_TYPE_RELATIONSHIP &&
          Array.isArray(refEntry.fields.targetPaths)
        ) {
          clonedEntry = {
            specType: refEntry.specType,
            fields: {
              ...refEntry.fields,
              targetPaths: (refEntry.fields.targetPaths as string[]).map((tp) =>
                tp === sourceRoot || tp.startsWith(sourceRoot + "/")
                  ? primPath + tp.slice(sourceRoot.length)
                  : tp
              ),
            },
          };
        }

        if (!merged[mappedPath]) {
          merged[mappedPath] = clonedEntry;
        } else if (merged[mappedPath].specType === SPEC_TYPE_PRIM) {
          // Local fields win over referenced fields; merge apiSchemas & primChildren
          const localFields = merged[mappedPath].fields;
          const refSchemas = parseBracketedStrings(clonedEntry.fields.apiSchemas);
          const localSchemas = parseBracketedStrings(localFields.apiSchemas);
          const mergedSchemas = Array.from(new Set([...refSchemas, ...localSchemas]));

          merged[mappedPath] = {
            specType: SPEC_TYPE_PRIM,
            fields: {
              ...clonedEntry.fields,
              ...localFields,
              typeName: localFields.typeName || clonedEntry.fields.typeName,
              ...(mergedSchemas.length > 0 ? { apiSchemas: mergedSchemas } : {}),
            },
          };
        }
      }
    }
  }

  return merged;
}

/**
 * Walks the composed `THREE.Group` to attach `usdPrimPath`, `usdTypeName`, `usdPurpose`,
 * and `usdVisibility` onto `Object3D.userData`, and hides `purpose = "guide"` / `"proxy"`
 * or `visibility = "invisible"` collider meshes so they never double-render over visuals.
 */
function annotateComposedHierarchy(
  rootGroup: Object3D,
  specsByPath: USDSpecsByPath
): void {
  const readStringAttr = (primPath: string, attrName: string): string | undefined => {
    const spec = specsByPath[primPath + "." + attrName];
    if (spec?.specType === SPEC_TYPE_ATTRIBUTE && spec.fields.default !== undefined) {
      return String(spec.fields.default).trim().replace(/^["']|["']$/g, "");
    }
    return undefined;
  };

  const walk = (
    obj: Object3D,
    primPath: string,
    inheritedPurpose: string,
    inheritedVisibility: string,
    isReferenceWrapper = false
  ) => {
    const primSpec = specsByPath[primPath];
    const localPurpose = isReferenceWrapper ? undefined : readStringAttr(primPath, "purpose");
    const localVisibility = isReferenceWrapper ? undefined : readStringAttr(primPath, "visibility");

    const effectivePurpose =
      localPurpose && localPurpose !== "default" ? localPurpose : inheritedPurpose;
    const effectiveVisibility =
      localVisibility && localVisibility !== "inherited"
        ? localVisibility
        : inheritedVisibility;

    if (!isReferenceWrapper) {
      obj.userData.usdPrimPath = primPath;
      if (primSpec?.fields?.typeName) {
        obj.userData.usdTypeName = primSpec.fields.typeName;
      }
    }
    if (effectivePurpose !== "default") {
      obj.userData.usdPurpose = effectivePurpose;
    }
    if (effectiveVisibility !== "inherited") {
      obj.userData.usdVisibility = effectiveVisibility;
    }

    if (
      effectivePurpose === "guide" ||
      effectivePurpose === "proxy" ||
      effectiveVisibility === "invisible"
    ) {
      obj.visible = false;
    }

    for (const child of obj.children) {
      if (!child.name) continue;
      const candidatePath =
        primPath === "/" ? "/" + child.name : primPath + "/" + child.name;
      if (specsByPath[candidatePath]) {
        walk(child, candidatePath, effectivePurpose, effectiveVisibility, false);
      } else {
        // Check active variant child paths if any
        const variantPrefix = primPath === "/" ? "/{" : primPath + "/{";
        let matchedVariantChild: string | null = null;
        for (const p of Object.keys(specsByPath)) {
          if (
            p.startsWith(variantPrefix) &&
            p.endsWith("/" + child.name) &&
            specsByPath[p].specType === SPEC_TYPE_PRIM
          ) {
            matchedVariantChild = p;
            break;
          }
        }
        if (matchedVariantChild) {
          walk(child, matchedVariantChild, effectivePurpose, effectiveVisibility, false);
        } else if (
          primSpec &&
          (primSpec.fields.references !== undefined ||
            primSpec.fields.payload !== undefined)
        ) {
          // Three.js USDComposer inserts the referenced root prim (e.g. "EuroPallet")
          // as a child wrapper under the referencing prim ("Pallet_01"), whereas OpenUSD
          // merges the referenced root's children directly under `primPath`.
          walk(child, primPath, effectivePurpose, effectiveVisibility, true);
        }
      }
    }
  };

  walk(rootGroup, "/", "default", "inherited");
}

/**
 * Pure-JavaScript OpenUSD + SimReady loader for Three.js, React Three Fiber, Rapier, and Ecctrl.
 *
 * Supports `.usd`, `.usda` (ASCII), `.usdc` (binary Crate + LZ4 + `TokenListOp` `apiSchemas`),
 * and `.usdz` archives **without** WebAssembly pthreads, `SharedArrayBuffer`, or COOP/COEP headers.
 */
export class SimReadyUSDLoader extends Loader<SimReadyUSDAsset> {
  declare public extractOptions: ExtractSimReadyOptions;

  constructor(manager?: LoadingManager, extractOptions: ExtractSimReadyOptions = {}) {
    super(manager);
    this.extractOptions = extractOptions;
  }

  override load(
    url: string,
    onLoad: (data: SimReadyUSDAsset) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void
  ): void {
    const loader = new FileLoader(this.manager);
    loader.setPath(this.path);
    loader.setResponseType("arraybuffer");
    loader.setRequestHeader(this.requestHeader);
    loader.setWithCredentials(this.withCredentials);

    loader.load(
      url,
      (buffer) => {
        try {
          onLoad(this.parse(buffer as ArrayBuffer));
        } catch (err) {
          if (onError) onError(err);
          else console.error(err);
          this.manager.itemError(url);
        }
      },
      onProgress,
      onError
    );
  }

  parse(buffer: ArrayBuffer | Uint8Array | string): SimReadyUSDAsset {
    const usda = new SimReadyUSDAParser();
    const usdc = new SimReadyUSDCParser();
    const textDecoder = new TextDecoder();

    let rootParsed: { specsByPath: USDSpecsByPath };
    const composerAssets: Record<string, unknown> = {};
    const sublayerSpecs: Record<string, USDSpecsByPath> = {};
    let basePath = "";

    if (typeof buffer === "string") {
      rootParsed = usda.parseData(buffer);
    } else if (isCrateBuffer(buffer)) {
      rootParsed = usdc.parseData(toArrayBuffer(buffer));
    } else {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

      // PK zip header -> USDZ container
      if (bytes.byteLength >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
        const zip = unzipSync(bytes);
        const fileNames = Object.keys(zip);
        if (fileNames.length === 0) {
          throw new Error("SimReadyUSDLoader: Empty USDZ archive.");
        }

        for (const filename of fileNames) {
          const fileBytes = zip[filename];
          const ext = getLowercaseExtension(filename);

          if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "avif") {
            composerAssets[filename] = fileBytes;
            continue;
          }

          if (ext !== "usd" && ext !== "usda" && ext !== "usdc") continue;

          const parsedLayer = isCrateBuffer(fileBytes)
            ? usdc.parseData(toArrayBuffer(fileBytes))
            : usda.parseData(textDecoder.decode(fileBytes));

          composerAssets[filename] = parsedLayer;
          sublayerSpecs[filename] = parsedLayer.specsByPath;
        }

        // Per AOUSD Core Spec 16.4.1.2, first entry is the root layer
        const rootFile =
          fileNames.find((fn) => {
            const ext = getLowercaseExtension(fn);
            return ext === "usd" || ext === "usda" || ext === "usdc";
          }) || fileNames[0];

        const lastSlash = rootFile.lastIndexOf("/");
        basePath = lastSlash >= 0 ? rootFile.slice(0, lastSlash) : "";

        const rootData = composerAssets[rootFile] as
          | { specsByPath: USDSpecsByPath }
          | undefined;
        if (!rootData?.specsByPath) {
          throw new Error(
            `SimReadyUSDLoader: Failed to parse root USD layer "${rootFile}".`
          );
        }
        rootParsed = rootData;
      } else {
        // Standalone USDA passed as ArrayBuffer / Uint8Array
        rootParsed = usda.parseData(textDecoder.decode(bytes));
      }
    }

    const composer = new TypedUSDComposer(this.manager);
    const group = composer.compose(rootParsed, composerAssets, {}, basePath);

    const effectiveSpecs =
      Object.keys(sublayerSpecs).length > 0
        ? mergeReferencedSpecs(rootParsed.specsByPath, sublayerSpecs, basePath)
        : rootParsed.specsByPath;

    annotateComposedHierarchy(group, effectiveSpecs);

    const physics = extractSimReadyPhysics(group, effectiveSpecs, this.extractOptions);

    return {
      group,
      specsByPath: effectiveSpecs,
      sublayerSpecs,
      upAxis: physics.upAxis,
      metersPerUnit: physics.metersPerUnit,
      kilogramsPerUnit: physics.kilogramsPerUnit,
      physics,
    };
  }
}

/**
 * React Three Fiber suspense hook for loading SimReady `.usd` / `.usda` / `.usdc` / `.usdz`
 * stages without `SharedArrayBuffer` or COOP/COEP headers.
 */
export function useSimReadyUSD(url: string): SimReadyUSDAsset;
export function useSimReadyUSD(urls: string[]): SimReadyUSDAsset[];
export function useSimReadyUSD(
  url: string | string[]
): SimReadyUSDAsset | SimReadyUSDAsset[] {
  return useLoader(SimReadyUSDLoader, url);
}

useSimReadyUSD.preload = (url: string | string[]) => {
  useLoader.preload(SimReadyUSDLoader, url);
};

useSimReadyUSD.clear = (url: string | string[]) => {
  useLoader.clear(SimReadyUSDLoader, url);
};
