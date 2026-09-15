import { spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { MCPServerConfig } from '../shared/types'

export type MCPToolDef = {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export type MCPToolCall = { name: string; arguments: Record<string, unknown> }

class ServerConnection {
  client: Client
  transport: StdioClientTransport
  tools: MCPToolDef[] = []
  connected = false

  constructor(public config: MCPServerConfig) {
    this.client = new Client({ name: 'meencode', version: '0.1.0' })
    this.transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
      stderr: 'pipe'
    })
  }

  async connect(): Promise<void> {
    if (this.connected) return
    await this.client.connect(this.transport)
    this.connected = true
    const list = await this.client.listTools()
    this.tools = list.tools.map((t) => ({
      name: `${this.config.name}.${t.name}`,
      description: `[${this.config.name}] ${t.description ?? ''}`,
      parameters: t.inputSchema as any
    }))
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected) await this.connect()
    const baseName = toolName.slice(this.config.name.length + 1)
    const timeout = this.config.timeout ?? 60000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const result = await this.client.callTool({ name: baseName, arguments: args }, undefined, { signal: controller.signal })
      clearTimeout(timer)
      if ((result as any).isError) {
        const text = this.extractText(result)
        return `Error from ${toolName}: ${text}`
      }
      return this.extractText(result)
    } catch (e: any) {
      clearTimeout(timer)
      if (e?.name === 'AbortError') return `Error: ${toolName} timed out after ${timeout}ms`
      return `Error calling ${toolName}: ${e?.message ?? String(e)}`
    }
  }

  private extractText(result: any): string {
    const parts = (result.content ?? []).map((c: any) => {
      if (c.type === 'text') return c.text
      if (c.type === 'image') return `[image: ${c.mimeType ?? 'unknown'} ${c.data?.slice(0, 30)}...]`
      if (c.type === 'resource') return `[resource: ${c.resource?.uri ?? ''}]`
      return JSON.stringify(c)
    })
    return parts.join('\n') || JSON.stringify(result)
  }

  async disconnect(): Promise<void> {
    try { await this.transport.close() } catch { /* ignore */ }
    this.connected = false
  }
}

export class MCPManager {
  private servers = new Map<string, ServerConnection>()

  async refresh(configs: MCPServerConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled)
    const nextIds = new Set(enabled.map((c) => c.id))
    // disconnect removed or disabled servers
    for (const [id, conn] of this.servers) {
      if (!nextIds.has(id)) {
        await conn.disconnect()
        this.servers.delete(id)
      }
    }
    for (const cfg of enabled) {
      let conn = this.servers.get(cfg.id)
      if (!conn || this.configChanged(conn.config, cfg)) {
        if (conn) await conn.disconnect()
        conn = new ServerConnection(cfg)
        this.servers.set(cfg.id, conn)
      }
      try {
        await conn.connect()
      } catch (e: any) {
        console.warn(`MCP server ${cfg.name} failed to connect:`, e?.message ?? e)
      }
    }
  }

  getTools(): MCPToolDef[] {
    return [...this.servers.values()].flatMap((s) => s.tools)
  }

  async call(toolName: string, args: Record<string, unknown>): Promise<string> {
    const serverName = toolName.split('.')[0]
    for (const [id, conn] of this.servers) {
      if (conn.config.name === serverName) {
        return conn.call(toolName, args)
      }
    }
    return `Error: no MCP server handles tool "${toolName}"`
  }

  async dispose(): Promise<void> {
    for (const conn of this.servers.values()) await conn.disconnect()
    this.servers.clear()
  }

  private configChanged(a: MCPServerConfig, b: MCPServerConfig): boolean {
    return a.command !== b.command ||
      (a.args ?? []).join(' ') !== (b.args ?? []).join(' ') ||
      JSON.stringify(a.env ?? {}) !== JSON.stringify(b.env ?? {})
  }
}

export const mcpManager = new MCPManager()
