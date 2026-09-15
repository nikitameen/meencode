import { createCanvas, Image } from 'canvas'
import fs from 'node:fs'

const MAX_DIM = 1024
const JPEG_QUALITY = 0.8
const MAX_OUTPUT_BYTES = 1.5 * 1024 * 1024

/**
 * Resize an image to a max dimension and encode it as base64 JPEG.
 * Falls back to the original base64 if resizing fails.
 */
export function resizeImageToBase64(abs: string): { dataUrl: string; mime: string; resized: boolean } {
  try {
    const buf = fs.readFileSync(abs)
    const img = new Image()
    img.src = buf
    let w = img.width
    let h = img.height
    if (w === 0 || h === 0) throw new Error('invalid image')

    if (w <= MAX_DIM && h <= MAX_DIM && buf.length <= MAX_OUTPUT_BYTES) {
      const ext = abs.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, resized: false }
    }

    const scale = Math.min(1, MAX_DIM / Math.max(w, h))
    w = Math.round(w * scale)
    h = Math.round(h * scale)
    const canvas = createCanvas(w, h)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, w, h)
    let out = canvas.toBuffer('image/jpeg', { quality: JPEG_QUALITY })
    // If still too large, drop quality
    if (out.length > MAX_OUTPUT_BYTES) {
      out = canvas.toBuffer('image/jpeg', { quality: 0.5 })
    }
    return { dataUrl: `data:image/jpeg;base64,${out.toString('base64')}`, mime: 'image/jpeg', resized: true }
  } catch (e) {
    // fallback: return original base64
    const ext = abs.split('.').pop()?.toLowerCase() ?? 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    const buf = fs.readFileSync(abs)
    return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, resized: false }
  }
}
