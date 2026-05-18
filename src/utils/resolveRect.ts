/**
 * Converts percentage or absolute values to percentage values
 * @param v - The value to convert
 * @returns The value as a percentage (0-100) or null if missing
 */
function pctOrNull(v: number | undefined): number | null {
	if (v === undefined || v === null) {
		return null
	}
	// If between 0-1, treat as fraction and convert to percentage
	if (v >= 0 && v <= 1) {
		return v * 100
	}
	// Otherwise assume it's already a percentage (0-100)
	return v
}

type SurfaceSize = {
	width: number
	height: number
}

function toFiniteNumber(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null
	}

	return value
}

function getScale(referenceSize: number | null, renderSize: number): number {
	if (referenceSize && referenceSize > 0) {
		return renderSize / referenceSize
	}

	return 1
}

/**
 * Resolved rectangle dimensions in pixels
 */
export type ResolvedRect = {
	x: number
	y: number
	width: number
	height: number
}

/**
 * Element properties for resolution
 */
export type ElementWithPosition = {
	x?: number
	y?: number
	width?: number
	height?: number
	xPct?: number
	yPct?: number
	widthPct?: number
	heightPct?: number
}

export type ResponsiveRect = {
	x: number | null
	y: number | null
	width: number | null
	height: number | null
}

/**
 * Converts element position/size from percentage and absolute values to pixel coordinates
 * 
 * Drop-in mapping function that handles:
 * - Percentage-based positioning (xPct, yPct, widthPct, heightPct)
 * - Fallback to absolute values (x, y, width, height)
 * - Backward compatibility with old templates
 * 
 * Algorithm:
 * 1. Check for percentage values - use if present
 * 2. Fall back to absolute values and compute percentage using layout dimensions
 * 3. Convert percentages to pixel coordinates using actual viewport dimensions
 * 
 * @param element - Element with position properties
 * @param layoutWidth - Layout template width (for backward compatibility)
 * @param layoutHeight - Layout template height (for backward compatibility)
 * @param viewportWidth - Actual display viewport width
 * @param viewportHeight - Actual display viewport height
 * @returns Resolved rectangle in pixels
 */
export function resolveRect(
	element: ElementWithPosition,
	layoutWidth: number,
	layoutHeight: number,
	viewportWidth: number,
	viewportHeight: number,
): ResolvedRect {
	// Determine X percentage
	const xp = pctOrNull(element.xPct) ?? (element.x !== undefined && layoutWidth > 0 ? (element.x / layoutWidth) * 100 : 0)

	// Determine Y percentage
	const yp = pctOrNull(element.yPct) ?? (element.y !== undefined && layoutHeight > 0 ? (element.y / layoutHeight) * 100 : 0)

	// Determine Width percentage
	const wp = pctOrNull(element.widthPct) ?? (element.width !== undefined && layoutWidth > 0 ? (element.width / layoutWidth) * 100 : 100)

	// Determine Height percentage
	const hp = pctOrNull(element.heightPct) ?? (element.height !== undefined && layoutHeight > 0 ? (element.height / layoutHeight) * 100 : 100)

	// Convert percentages to pixel coordinates
	return {
		x: Math.round((xp / 100) * viewportWidth),
		y: Math.round((yp / 100) * viewportHeight),
		width: Math.round((wp / 100) * viewportWidth),
		height: Math.round((hp / 100) * viewportHeight),
	}
}

/**
 * Resolves template element geometry against the live render surface.
 * Percentage coordinates win; legacy pixel coordinates scale from a reference size
 * when one is available, otherwise they are used as-is.
 */
export function resolveResponsiveRect(
	element: ElementWithPosition,
	renderSize: SurfaceSize,
	referenceSize?: Partial<SurfaceSize>,
): ResponsiveRect {
	const scaleX = getScale(toFiniteNumber(referenceSize?.width), renderSize.width)
	const scaleY = getScale(toFiniteNumber(referenceSize?.height), renderSize.height)

	const xPct = pctOrNull(element.xPct)
	const yPct = pctOrNull(element.yPct)
	const widthPct = pctOrNull(element.widthPct)
	const heightPct = pctOrNull(element.heightPct)

	return {
		x: xPct !== null ? Math.round((xPct / 100) * renderSize.width) : (element.x !== undefined ? Math.round(element.x * scaleX) : null),
		y: yPct !== null ? Math.round((yPct / 100) * renderSize.height) : (element.y !== undefined ? Math.round(element.y * scaleY) : null),
		width: widthPct !== null ? Math.round((widthPct / 100) * renderSize.width) : (element.width !== undefined ? Math.round(element.width * scaleX) : null),
		height: heightPct !== null ? Math.round((heightPct / 100) * renderSize.height) : (element.height !== undefined ? Math.round(element.height * scaleY) : null),
	}
}

/**
 * Scales a font size or other pixel length using the smaller axis scale.
 */
export function resolveResponsiveFontSize(
	fontSize: unknown,
	referenceSize: Partial<SurfaceSize> | undefined,
	renderSize: SurfaceSize,
): string | undefined {
	const referenceWidth = toFiniteNumber(referenceSize?.width)
	const referenceHeight = toFiniteNumber(referenceSize?.height)
	const scaleX = getScale(referenceWidth, renderSize.width)
	const scaleY = getScale(referenceHeight, renderSize.height)
	const scale = Math.min(scaleX, scaleY)

	if (typeof fontSize === 'number' && Number.isFinite(fontSize)) {
		return `${Math.round(fontSize * scale)}px`
	}

	if (typeof fontSize === 'string') {
		const trimmed = fontSize.trim()
		const match = trimmed.match(/^(-?\d+(?:\.\d+)?)px$/i)

		if (match) {
			return `${Math.round(Number(match[1]) * scale)}px`
		}

		return trimmed
	}

	return undefined
}

/**
 * Clamps a color value to ensure it's valid
 * @param color - The CSS color value
 * @returns The color if valid and non-empty, otherwise null
 */
export function resolveBackgroundColor(color?: string): string | null {
	if (!color || typeof color !== 'string' || color.trim() === '') {
		return null
	}
	return color.trim()
}

/**
 * Resolve background CSS properties
 * @param backgroundColor - Primary background color
 * @param fallbackBackground - Fallback background color (legacy field)
 * @param defaultColor - Default color if nothing provided
 * @returns Resolved background color
 */
export function resolveBackgroundColorWithFallback(
	backgroundColor?: string,
	fallbackBackground?: string,
	defaultColor: string = '#0f172a',
): string {
	const primary = resolveBackgroundColor(backgroundColor)
	if (primary) return primary

	const fallback = resolveBackgroundColor(fallbackBackground)
	if (fallback) return fallback

	return defaultColor
}

/**
 * Get background image CSS properties based on fit mode
 * @param imageUrl - Background image URL
 * @param fitMode - How to fit the image: 'cover', 'contain', 'fill'
 * @returns CSS object-fit and background-size values
 */
export function getBackgroundImageFitStyle(
	fitMode?: 'cover' | 'contain' | 'fill',
): { objectFit: string; backgroundSize: string } {
	switch (fitMode) {
		case 'cover':
			return { objectFit: 'cover', backgroundSize: 'cover' }
		case 'contain':
			return { objectFit: 'contain', backgroundSize: 'contain' }
		case 'fill':
			return { objectFit: 'fill', backgroundSize: '100% 100%' }
		default:
			return { objectFit: 'cover', backgroundSize: 'cover' }
	}
}
