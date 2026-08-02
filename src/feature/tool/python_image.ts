/** Discover and decode image artifacts produced by Python runs. */
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

export interface PythonPixelImage {
	width: number;
	height: number;
	rgba: Uint8Array;
}

export interface PythonImageArtifact {
	path: string;
	mimeType?: string;
	data?: string;
	pixels?: PythonPixelImage;
	pngData?: string;
	error?: string;
}

export const PYTHON_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const PYTHON_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

// ========================================
// Artifact Detection

/** Calculate the PNG Paeth filter predictor.
 *
 * Example:
 * >>> PythonPaeth(10, 20, 5)
 * 10
 */
function PythonPaeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode common non-interlaced, 8-bit PNGs for terminal Unicode previews.
 *
 * Example:
 * >>> PythonPngDecode(pngBytes)
 * { width: 10, height: 10, rgba: Uint8Array(400) }
 */
export function PythonPngDecode(
	bytes: Uint8Array,
): PythonPixelImage | undefined {
	// Reject non-PNG input before allocating decoder state.
	if (
		bytes.length < 24 ||
		Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
	) {
		return undefined;
	}
	let width = 0;
	let height = 0;
	let bitDepth = 0;
	let colorType = 0;
	let interlace = 0;
	let palette: Uint8Array | undefined;
	let transparency: Uint8Array | undefined;
	// IDAT payloads may be split across any number of chunks.
	const idat: Uint8Array[] = [];

	// Walk PNG chunks and retain only fields required by the lightweight decoder.
	for (let offset = 8; offset + 12 <= bytes.length; ) {
		const length = Buffer.from(
			bytes.buffer,
			bytes.byteOffset + offset,
			4,
		).readUInt32BE(0);
		const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString(
			"ascii",
		);
		const start = offset + 8;
		const end = start + length;
		if (end + 4 > bytes.length) {
			return undefined;
		}
		// Dispatch each bounded chunk by its four-byte PNG type.
		const data = bytes.subarray(start, end);
		if (type === "IHDR" && data.length >= 13) {
			width = Buffer.from(
				data.buffer,
				data.byteOffset,
				data.byteLength,
			).readUInt32BE(0);
			height = Buffer.from(
				data.buffer,
				data.byteOffset,
				data.byteLength,
			).readUInt32BE(4);
			// Record the pixel format needed for later scanline reconstruction.
			bitDepth = data[8]!;
			colorType = data[9]!;
			interlace = data[12]!;
		} else if (type === "PLTE") {
			palette = data.slice();
		} else if (type === "tRNS") {
			transparency = data.slice();
		} else if (type === "IDAT") {
			idat.push(data.slice());
		} else if (type === "IEND") {
			break;
		}
		offset = end + 4;
	}

	// Map the PNG color type to bytes per source pixel.
	const channels =
		colorType === 0
			? 1
			: colorType === 2
				? 3
				: colorType === 3
					? 1
					: colorType === 4
						? 2
						: colorType === 6
							? 4
							: 0;
	// Reject unsupported formats and pathological allocations.
	if (
		!width ||
		!height ||
		width * height > 40_000_000 ||
		bitDepth !== 8 ||
		interlace !== 0 ||
		channels === 0 ||
		idat.length === 0
	) {
		return undefined;
	}
	// Indexed-color PNGs require a palette before pixel expansion.
	if (colorType === 3 && !palette) {
		return undefined;
	}

	try {
		// Inflate and reconstruct filtered scanlines before converting them to RGBA.
		const packed = inflateSync(
			Buffer.concat(idat.map((part) => Buffer.from(part))),
		);
		const stride = width * channels;
		if (packed.length < (stride + 1) * height) {
			return undefined;
		}
		const scan = new Uint8Array(stride * height);
		let input = 0;
		// Reconstruct each scanline from its preceding pixel and row.
		for (let y = 0; y < height; y++) {
			const filter = packed[input++]!;
			for (let x = 0; x < stride; x++) {
				const raw = packed[input++]!;
				const left = x >= channels ? scan[y * stride + x - channels]! : 0;
				const up = y > 0 ? scan[(y - 1) * stride + x]! : 0;
				const upperLeft =
					y > 0 && x >= channels ? scan[(y - 1) * stride + x - channels]! : 0;
				// Apply the PNG filter selected by the scanline prefix byte.
				const value =
					filter === 0
						? raw
						: filter === 1
							? raw + left
							: filter === 2
								? raw + up
								: filter === 3
									? raw + Math.floor((left + up) / 2)
									: filter === 4
										? raw + PythonPaeth(left, up, upperLeft)
										: Number.NaN;
				// Unknown filter values fail decoding instead of corrupting output.
				if (!Number.isFinite(value)) {
					return undefined;
				}
				scan[y * stride + x] = value & 0xff;
			}
		}

		const rgba = new Uint8Array(width * height * 4);
		// Expand grayscale, RGB, palette, and alpha variants into RGBA.
		for (let pixel = 0; pixel < width * height; pixel++) {
			const source = pixel * channels;
			const target = pixel * 4;
			if (colorType === 0) {
				rgba[target] = rgba[target + 1] = rgba[target + 2] = scan[source]!;
				rgba[target + 3] = 255;
			} else if (colorType === 2) {
				rgba[target] = scan[source]!;
				rgba[target + 1] = scan[source + 1]!;
				rgba[target + 2] = scan[source + 2]!;
				rgba[target + 3] = 255;
			} else if (colorType === 3) {
				// Palette transparency defaults to opaque when tRNS omits an index.
				const index = scan[source]!;
				rgba[target] = palette![index * 3] ?? 0;
				rgba[target + 1] = palette![index * 3 + 1] ?? 0;
				rgba[target + 2] = palette![index * 3 + 2] ?? 0;
				rgba[target + 3] = transparency?.[index] ?? 255;
			// Preserve explicit alpha channels in grayscale and true-color inputs.
			} else if (colorType === 4) {
				rgba[target] = rgba[target + 1] = rgba[target + 2] = scan[source]!;
				rgba[target + 3] = scan[source + 1]!;
			} else {
				rgba[target] = scan[source]!;
				rgba[target + 1] = scan[source + 1]!;
				rgba[target + 2] = scan[source + 2]!;
				rgba[target + 3] = scan[source + 3]!;
			}
		}
		return { width, height, rgba };
	} catch {
		return undefined;
	}
}

/** Resolve a supported static image MIME type from its extension.
 *
 * Example:
 * >>> PythonImageMime("plot.webp")
 * "image/webp"
 */
export function PythonImageMime(path: string): string | undefined {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

/** Load Photon's decoder from Pi's own installed dependencies.
 *
 * Example:
 * >>> PythonPhotonModule()
 * { PhotonImage: ... }
 */
function PythonPhotonModule(): any | undefined {
	try {
		const resolveImport = import.meta.resolve!.bind(import.meta) as unknown as (specifier: string) => string;
		const piEntry = fileURLToPath(resolveImport("@earendil-works/pi-coding-agent"));
		const piRequire = createRequire(piEntry);
		return piRequire(piRequire.resolve("@silvia-odwyer/photon-node"));
	} catch {
		return undefined;
	}
}

/** Decode JPEG or WebP bytes to RGBA and a PNG terminal payload.
 *
 * Example:
 * >>> PythonPhotonDecode(jpegBytes)
 * { pixels: { width: 10, height: 10, rgba: Uint8Array(400) }, pngData: "..." }
 */
function PythonPhotonDecode(bytes: Uint8Array): { pixels: PythonPixelImage; pngData: string } | undefined {
	const photon = PythonPhotonModule();
	if (!photon?.PhotonImage) {
		return undefined;
	}
	let image: any;
	try {
		// Photon supplies static JPEG/WebP decoding and a PNG payload for Kitty.
		image = photon.PhotonImage.new_from_byteslice(bytes);
		const width = image.get_width();
		const height = image.get_height();
		const rgba = new Uint8Array(image.get_raw_pixels());
		if (!width || !height || rgba.length !== width * height * 4) {
			return undefined;
		}
		// Retain pixels for Sixel/Unicode and a PNG copy for Kitty.
		return {
			pixels: { width, height, rgba },
			pngData: Buffer.from(image.get_bytes()).toString("base64"),
		};
	} catch {
		return undefined;
	} finally {
		image?.free?.();
	}
}

/** Extract supported local image paths from stdout in mention order.
 *
 * Example:
 * >>> PythonFindImagePaths('saved "plots/my plot.png" and ./other.webp')
 * ["plots/my plot.png", "./other.webp"]
 */
export function PythonFindImagePaths(output: string): string[] {
	const matches: Array<{ index: number; path: string }> = [];
	const occupied: Array<{ start: number; end: number }> = [];
	// Capture quoted paths first so spaces remain unambiguous.
	for (const match of output.matchAll(/(["'`])([^"'`\r\n]+?\.(?:png|jpe?g|webp))\1/gi)) {
		if (match.index === undefined || !match[2]) {
			continue;
		}
		matches.push({ index: match.index, path: match[2] });
		occupied.push({ start: match.index, end: match.index + match[0].length });
	}
	const pathPattern = /(?:^|[\s=:])((?:(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])[^\r\n"'`]*?|[^\s"'`]+?)\.(?:png|jpe?g|webp))(?=$|[\s),;:])/gim;
	// Capture unquoted standalone or embedded paths without duplicating quoted matches.
	for (const match of output.matchAll(pathPattern)) {
		if (match.index === undefined || !match[1]) {
			continue;
		}
		const relativeStart = match[0].lastIndexOf(match[1]);
		const start = match.index + Math.max(0, relativeStart);
		const end = start + match[1].length;
		if (occupied.some((range) => start >= range.start && end <= range.end)) {
			continue;
		}
		matches.push({ index: start, path: match[1].replace(/[),:;]+$/, "") });
	}
	matches.sort((left, right) => left.index - right.index);
	const paths = matches.map((match) => match.path);
	return paths;
}

/** Read and decode one local image, returning visible errors for failed previews.
 *
 * Example:
 * >>> PythonLoadImage("plot.png", "/tmp")
 * { path: "/tmp/plot.png", mimeType: "image/png", data: "...", pixels: ... }
 */
export function PythonLoadImage(candidate: string, cwd: string): PythonImageArtifact {
	const mimeType = PythonImageMime(candidate);
	const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
	if (!mimeType || !PYTHON_IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
		return { path, error: `Error: unsupported image format: ${candidate}` };
	}
	try {
		// Validate filesystem bounds before reading or decoding image bytes.
		const stat = statSync(path);
		if (!stat.isFile()) {
			return { path, error: `Error: image is not a file: ${candidate}` };
		}
		if (stat.size === 0) {
			return { path, error: `Error: image is empty: ${candidate}` };
		}
		// Bound each payload before base64 and RGBA expansion.
		if (stat.size > PYTHON_IMAGE_MAX_BYTES) {
			return { path, error: `Error: image exceeds the 8 MB limit: ${candidate}` };
		}
		const bytes = readFileSync(path);
		const data = bytes.toString("base64");
		// Decode every format to pixels while preserving its original native payload.
		const pngPixels = mimeType === "image/png" ? PythonPngDecode(bytes) : undefined;
		const converted = pngPixels ? undefined : PythonPhotonDecode(bytes);
		const pixels = pngPixels ?? converted?.pixels;
		if (!pixels) {
			return { path, error: `Error: image could not be decoded: ${candidate}` };
		}
		return { path, mimeType, data, pixels, pngData: mimeType === "image/png" ? data : converted?.pngData };
	} catch {
		return { path, error: `Error: image is missing or unreadable: ${candidate}` };
	}
}
