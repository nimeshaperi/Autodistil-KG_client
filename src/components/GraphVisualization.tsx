import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { TraversalProgressEvent, WsEvent } from '@/api/client'

/* ------------------------------------------------------------------ */
/*  Types for the force-directed graph                                 */
/* ------------------------------------------------------------------ */

interface GraphNode {
  id: string
  labels: string[]
  state: 'pending' | 'processing' | 'completed' | 'failed'
  depth: number
  /** Animation progress 0-1 for pulse effect */
  __pulse?: number
  /** Timestamp when node started processing */
  __startedAt?: number
  /** Number of conversations generated from this node */
  conversations?: number
  /** Number of paths analyzed */
  pathsAnalyzed?: number
  x?: number
  y?: number
  fx?: number
  fy?: number
}

interface GraphLink {
  source: string
  target: string
  label?: string
}

interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

/* ------------------------------------------------------------------ */
/*  Derive graph data from traversal events                            */
/* ------------------------------------------------------------------ */

function deriveGraphData(events: TraversalProgressEvent[]): {
  graphData: GraphData
  strategy: string
  visited: number
  total: number
  datasetSize: number
  done: boolean
  currentNodeId: string | null
} {
  const nodeMap = new Map<string, GraphNode>()
  const linkSet = new Set<string>()
  const links: GraphLink[] = []
  let strategy = ''
  let visited = 0
  let total = 0
  let datasetSize = 0
  let done = false
  let currentNodeId: string | null = null
  let lastNodeId: string | null = null

  for (const ev of events) {
    switch (ev.type) {
      case 'traversal_start':
        strategy = ev.strategy ?? ''
        total = ev.max_nodes ?? 0
        break

      case 'node_start': {
        const id = ev.node_id ?? '?'
        currentNodeId = id
        if (!nodeMap.has(id)) {
          nodeMap.set(id, {
            id,
            labels: ev.labels ?? [],
            state: 'processing',
            depth: ev.depth ?? 0,
            __startedAt: Date.now(),
          })
        } else {
          const existing = nodeMap.get(id)!
          existing.state = 'processing'
          existing.labels = ev.labels ?? existing.labels
          existing.__startedAt = Date.now()
        }
        // Create link from previous node to current (traversal edge)
        if (lastNodeId && lastNodeId !== id) {
          const linkKey = `${lastNodeId}→${id}`
          if (!linkSet.has(linkKey)) {
            linkSet.add(linkKey)
            links.push({ source: lastNodeId, target: id })
          }
        }
        if (ev.total) total = ev.total
        break
      }

      case 'subgraph_loaded': {
        // For reasoning strategy, we get subgraph info
        const id = ev.node_id
        if (id && nodeMap.has(id)) {
          const node = nodeMap.get(id)!
          node.labels = ev.labels ?? node.labels
        }
        break
      }

      case 'node_done': {
        const id = ev.node_id ?? '?'
        if (nodeMap.has(id)) {
          const node = nodeMap.get(id)!
          node.state = 'completed'
          node.conversations = ev.conversations
          node.pathsAnalyzed = ev.paths_analyzed
        }
        visited = ev.visited ?? visited
        datasetSize = ev.dataset_size ?? datasetSize
        lastNodeId = id
        if (currentNodeId === id) currentNodeId = null
        break
      }

      case 'traversal_complete':
        visited = ev.visited ?? visited
        datasetSize = ev.dataset_size ?? datasetSize
        done = true
        currentNodeId = null
        break
    }
  }

  return {
    graphData: {
      nodes: Array.from(nodeMap.values()),
      links,
    },
    strategy,
    visited,
    total,
    datasetSize,
    done,
    currentNodeId,
  }
}

/* ------------------------------------------------------------------ */
/*  Color schemes                                                      */
/* ------------------------------------------------------------------ */

const NODE_COLORS: Record<string, string> = {
  pending: '#94a3b8',    // slate-400
  processing: '#3b82f6', // blue-500
  completed: '#22c55e',  // green-500
  failed: '#ef4444',     // red-500
}

const NODE_COLORS_GLOW: Record<string, string> = {
  processing: 'rgba(59, 130, 246, 0.4)',
  completed: 'rgba(34, 197, 94, 0.15)',
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

interface GraphVisualizationProps {
  wsEvents: WsEvent[]
}

export default function GraphVisualization({ wsEvents }: GraphVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const graphRef = useRef<{ d3Force: (name: string) => unknown } | null>(null)
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 })
  const animFrameRef = useRef<number>(0)
  const [, forceRender] = useState(0)

  // Extract traversal events
  const traversalEvents = useMemo(
    () => wsEvents.filter((e): e is TraversalProgressEvent => e.event === 'traversal_progress'),
    [wsEvents],
  )

  const { graphData, strategy, visited, total, datasetSize, done, currentNodeId } = useMemo(
    () => deriveGraphData(traversalEvents),
    [traversalEvents],
  )

  // Don't render if no traversal events
  if (traversalEvents.length === 0) return null

  // Resize observer
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const { width } = entries[0].contentRect
      setDimensions({ width: Math.max(300, width), height: 400 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Animation loop for pulsing active nodes
  useEffect(() => {
    if (done) return
    let running = true
    const tick = () => {
      if (!running) return
      forceRender((n) => n + 1)
      animFrameRef.current = requestAnimationFrame(tick)
    }
    // Throttle to ~15fps for performance
    const interval = setInterval(() => {
      animFrameRef.current = requestAnimationFrame(tick)
    }, 66)
    return () => {
      running = false
      cancelAnimationFrame(animFrameRef.current)
      clearInterval(interval)
    }
  }, [done])

  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0
      const y = node.y ?? 0
      const isActive = node.id === currentNodeId || node.state === 'processing'
      const baseRadius = isActive ? 6 : node.state === 'completed' ? 5 : 4
      const radius = baseRadius / Math.max(globalScale * 0.5, 0.5)

      // Glow effect for active/completed nodes
      if (isActive) {
        const pulseT = ((Date.now() - (node.__startedAt ?? Date.now())) / 800) % 1
        const glowRadius = radius * (1.5 + pulseT * 1.5)
        const gradient = ctx.createRadialGradient(x, y, radius, x, y, glowRadius)
        gradient.addColorStop(0, NODE_COLORS_GLOW.processing!)
        gradient.addColorStop(1, 'rgba(59, 130, 246, 0)')
        ctx.beginPath()
        ctx.arc(x, y, glowRadius, 0, 2 * Math.PI)
        ctx.fillStyle = gradient
        ctx.fill()
      } else if (node.state === 'completed') {
        const gradient = ctx.createRadialGradient(x, y, radius, x, y, radius * 1.5)
        gradient.addColorStop(0, NODE_COLORS_GLOW.completed!)
        gradient.addColorStop(1, 'rgba(34, 197, 94, 0)')
        ctx.beginPath()
        ctx.arc(x, y, radius * 1.5, 0, 2 * Math.PI)
        ctx.fillStyle = gradient
        ctx.fill()
      }

      // Node circle
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, 2 * Math.PI)
      ctx.fillStyle = NODE_COLORS[node.state] ?? NODE_COLORS.pending
      ctx.fill()

      // Border
      ctx.strokeStyle = isActive ? '#1d4ed8' : node.state === 'completed' ? '#16a34a' : '#64748b'
      ctx.lineWidth = isActive ? 1.5 / globalScale : 0.5 / globalScale
      ctx.stroke()

      // Label (show when zoomed in enough or for active node)
      if (globalScale > 1.2 || isActive) {
        const fontSize = Math.max(10 / globalScale, 3)
        ctx.font = `${isActive ? 'bold ' : ''}${fontSize}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = isActive ? '#1e40af' : '#475569'

        // Truncate long IDs
        const label = node.id.length > 12 ? node.id.slice(0, 10) + '…' : node.id
        ctx.fillText(label, x, y + radius + 2 / globalScale)

        // Show labels as small badges
        if (node.labels.length > 0 && (globalScale > 2 || isActive)) {
          const badgeFont = Math.max(8 / globalScale, 2.5)
          ctx.font = `${badgeFont}px sans-serif`
          ctx.fillStyle = '#6366f1'
          ctx.fillText(node.labels.join(', '), x, y + radius + (fontSize + 4) / globalScale)
        }
      }
    },
    [currentNodeId],
  )

  const linkCanvasObject = useCallback(
    (link: GraphLink, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const src = link.source as unknown as GraphNode
      const tgt = link.target as unknown as GraphNode
      if (!src?.x || !tgt?.x) return

      ctx.beginPath()
      ctx.moveTo(src.x, src.y ?? 0)
      ctx.lineTo(tgt.x, tgt.y ?? 0)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)'
      ctx.lineWidth = 0.5 / globalScale
      ctx.stroke()

      // Arrow
      const dx = tgt.x - src.x
      const dy = (tgt.y ?? 0) - (src.y ?? 0)
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 1) return
      const nx = dx / dist
      const ny = dy / dist
      const arrowLen = 4 / globalScale
      const ax = tgt.x - nx * 6 / globalScale
      const ay = (tgt.y ?? 0) - ny * 6 / globalScale
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax - nx * arrowLen + ny * arrowLen * 0.4, ay - ny * arrowLen - nx * arrowLen * 0.4)
      ctx.lineTo(ax - nx * arrowLen - ny * arrowLen * 0.4, ay - ny * arrowLen + nx * arrowLen * 0.4)
      ctx.closePath()
      ctx.fillStyle = 'rgba(148, 163, 184, 0.5)'
      ctx.fill()
    },
    [],
  )

  const progressPct = total > 0 ? Math.round((visited / total) * 100) : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Graph Traversal Visualization</CardTitle>
          <div className="flex items-center gap-2">
            {strategy && (
              <Badge variant="secondary" className="text-xs capitalize">
                {strategy}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs tabular-nums">
              {visited}/{total} nodes
            </Badge>
            {done && (
              <Badge className="bg-green-600 text-white text-xs">Complete</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Legend */}
        <div className="flex items-center gap-4 mb-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
            Processing
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-green-500" />
            Completed
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-400" />
            Pending
          </div>
          <div className="ml-auto tabular-nums">
            {datasetSize} conversations
          </div>
        </div>

        {/* Graph canvas */}
        <div
          ref={containerRef}
          className="rounded-lg border bg-slate-950/5 dark:bg-slate-50/5 overflow-hidden"
          style={{ height: 400 }}
        >
          <ForceGraph2D
            ref={graphRef as React.MutableRefObject<never>}
            graphData={graphData}
            width={dimensions.width}
            height={dimensions.height}
            nodeCanvasObject={nodeCanvasObject as never}
            linkCanvasObject={linkCanvasObject as never}
            nodeId="id"
            cooldownTicks={graphData.nodes.length > 50 ? 80 : 150}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.3}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            backgroundColor="transparent"
            nodeLabel={(node: GraphNode) => {
              const parts = [`Node: ${node.id}`]
              if (node.labels.length) parts.push(`Labels: ${node.labels.join(', ')}`)
              parts.push(`State: ${node.state}`)
              parts.push(`Depth: ${node.depth}`)
              if (node.conversations) parts.push(`Conversations: ${node.conversations}`)
              if (node.pathsAnalyzed) parts.push(`Paths analyzed: ${node.pathsAnalyzed}`)
              return parts.join('\n')
            }}
          />
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="flex items-center gap-2 mt-3">
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500 transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums w-10 text-right">
              {progressPct}%
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
