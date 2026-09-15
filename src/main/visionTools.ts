import path from 'node:path'
import { OllamaCloudClient } from './agent/ollamaClient'
import type { Settings } from '../shared/types'
import { resizeImageToBase64 } from './imageResize'

export interface VisionCompareResult {
  summary: string
  differences: string[]
  recommendations: string[]
}

/**
 * Ask a vision-capable model to compare a live screenshot with a reference image.
 * Images must be local file paths. The function reads them as base64 and sends
 * them to the configured model as user image content in an OpenAI-compatible
 * chat completion.
 */
export async function compareScreenshots(
  settings: Settings,
  livePath: string,
  referencePath: string,
  prompt: string,
  signal?: AbortSignal
): Promise<VisionCompareResult> {
  const base = settings.baseUrl.replace(/\/+$/, '')
  const client = new OllamaCloudClient({
    apiKey: settings.apiKey,
    baseUrl: base,
    model: settings.model
  })

  const liveB64 = fileToBase64(livePath)
  const refB64 = fileToBase64(referencePath)
  const extLive = path.extname(livePath).slice(1) || 'png'
  const extRef = path.extname(referencePath).slice(1) || 'png'

  const userMessage: any = {
    role: 'user',
    content: [
      { type: 'text', text: buildComparePrompt(prompt) },
      { type: 'image_url', image_url: { url: `data:image/${extLive};base64,${liveB64}` } },
      { type: 'image_url', image_url: { url: `data:image/${extRef};base64,${refB64}` } }
    ]
  }

  const res = await client.chat(
    [
      { role: 'system', content: 'You are a meticulous UI/UX reviewer. Be concise and actionable.' },
      userMessage
    ],
    [],
    signal ?? new AbortController().signal,
    {}
  )

  return parseVisionCompare(res.content)
}

function buildComparePrompt(userPrompt: string): string {
  return [
    'The first image is the current UI screenshot; the second is the reference design.',
    'Compare them carefully and report: (1) a short summary, (2) visual/structural differences, (3) specific fix recommendations.',
    'Return ONLY a JSON object with keys: summary, differences (string array), recommendations (string array).',
    userPrompt ? `User context: ${userPrompt}` : ''
  ].filter(Boolean).join('\n')
}

function fileToBase64(p: string): string {
  const r = resizeImageToBase64(p)
  const comma = r.dataUrl.indexOf(',')
  return comma === -1 ? r.dataUrl : r.dataUrl.slice(comma + 1)
}

function parseVisionCompare(text: string): VisionCompareResult {
  const clean = text.replace(/```json\s*([\s\S]*?)\s*```/g, '$1').trim()
  try {
    const j = JSON.parse(clean)
    return {
      summary: String(j.summary ?? 'No summary provided.'),
      differences: Array.isArray(j.differences) ? j.differences.map(String) : [],
      recommendations: Array.isArray(j.recommendations) ? j.recommendations.map(String) : []
    }
  } catch {
    return {
      summary: clean.slice(0, 600),
      differences: [],
      recommendations: []
    }
  }
}
