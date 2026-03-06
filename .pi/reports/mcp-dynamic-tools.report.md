# MCP Dynamic Tool Loading/Unloading Architecture Report

## Executive Summary

Bu rapor, pi CLI'ye MCP (Model Context Protocol) destegi eklenmesi icin **runtime'da dinamik tool load/unload** mekanizmasi tasarimi uzerine derinlemesine bir analiz sunar. Claude'un Tool Search Tool yaklasimi, MCP protokolunun native `notifications/tools/list_changed` mekanizmasi ve Anthropic'in "Code Execution with MCP" yaklasimi incelenmis; pi CLI'nin mevcut extension/tool mimarisi uzerinde bu kavramlarin nasil uygulanabilecegi detaylandirilmistir.

---

## 1. Mevcut Durum Analizi

### 1.1 pi CLI Tool Mimarisi

pi CLI'nin tool sistemi su katmanlardan olusur:

```
Agent (pi-agent-core)
  └── AgentTool[] (setTools ile runtime'da degistirilebilir)
       ├── Base Tools: read, bash, edit, write, grep, find, ls, webfetch, websearch
       ├── Extension Tools: pi.registerTool() ile kaydedilen toollar
       └── SDK Custom Tools: createAgentSession({ customTools }) ile eklenenler
```

**Kritik noktalar:**
- `Agent.setTools()` runtime'da tool listesini degistirebilir
- `AgentSession._buildRuntime()` tum toolları yeniden olusturur (reload icin kullanilir)
- Extension sistemi `wrapToolsWithExtensions()` ile tool_call/tool_result event'lerini intercept edebilir
- `getActiveTools()` / `setActiveTools()` ile hangi toollarin aktif oldugu runtime'da degistirilebilir
- System prompt her turn basinda yeniden olusturulur ve aktif tool listesini icerir

### 1.2 Extension Sistemi

Extension'lar pi CLI'nin temel genisletme mekanizmasidir:
- Factory function pattern (`export default function(pi: ExtensionAPI)`)
- Event-driven lifecycle (session_start, context, tool_call, tool_result, turn_start, turn_end, vb.)
- `pi.registerTool()` ile LLM-callable tool kaydedebilir
- `pi.registerCommand()` ile slash command ekleyebilir
- `pi.on("context", ...)` ile LLM'e gonderilen mesajlari degistirebilir
- `pi.on("before_agent_start", ...)` ile system prompt'u override edebilir
- jiti ile TypeScript modulleri runtime'da yuklenir

### 1.3 pi'nin MCP Hakkindaki Mevcut Tutumu

README'den: *"No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."*

Bu, MCP desteginin **extension olarak** eklenmesinin beklendigi anlamina gelir — core'a degil. Bu tasarim felsefesine uygun bir yaklasim benimsenmelidir.

---

## 2. Sorun Tanimlama

### 2.1 Context Maliyeti Problemi

Tipik bir MCP kurulumunda (GitHub, Slack, Sentry, Grafana, Splunk):
- ~55K token yalnizca tool tanimlari icin harcanir
- pi CLI'nin varsayilan context window'u 200K token
- Bu, **context'in %27.5'inin** yalnizca tool tanimlarina gitmesi demektir
- Her ek MCP server ~5-15K token ekler

### 2.2 Tool Selection Accuracy

Claude'un dokumantasyonundan:
- 30-50 tool'u astiginda tool secim dogrulugu onemli olcude duser
- MCP server'lar kolayca 200+ tool sunabilir
- Tool search olmadan bu olcek yonetilmez

### 2.3 Hedef

Agent'in **ihtiyac duyuldugunda** MCP tool'larini kesfedip yuklemesi, kullandiktan sonra unload etmesi. Boylece:
- Context'te yalnizca aktif kullanilan tool tanimlari bulunur
- Tool secim dogrulugu yuksek kalir
- Session boyunca farkli MCP server'lardaki yuzlerce tool'a erisim mumkun olur

---

## 3. Ilham Kaynaklari

### 3.1 Claude Tool Search Tool

Claude'un server-side tool search mekanizmasi:

```
User request → Claude searches (regex/BM25) → tool_reference blocks → 
  auto-expanded to full definitions → Claude calls tool
```

**Onemli ozellikler:**
- `defer_loading: true` ile tool tanimlari context'e yuklenmez
- Arama sonucu 3-5 tool dondurur
- `tool_reference` bloklari otomatik olarak tam tanimlara genisletilir
- Custom client-side implementation desteklenir: `tool_result` icinde `tool_reference` bloklari dondurulebilir

**Pi icin uygulanabilirlik:** Claude'un API'si bu ozelligi sunuyor ancak pi, birden fazla provider destekliyor (OpenAI, Google, vb.). Server-side tool search yalnizca Claude API'ye ozgu. Ancak **client-side** tool search prensibi evrenseldir.

### 3.2 MCP Dynamic Tool Discovery

MCP protokolu native olarak dinamik tool degisikliklerini destekler:
- `notifications/tools/list_changed` — server'dan client'a tool listesi degisti bildirimi
- `tools/list` — guncel tool listesini sorgulama
- MCP TS SDK'da bu mekanizma otomatik olarak handle edilir

### 3.3 Code Execution with MCP (Anthropic Engineering)

Anthropic'in onerileri:
- MCP tool'larini dosya sistemi olarak sunma (progressive disclosure)
- Agent filesystem'i explore ederek tool'lari kesif eder
- Tool tanimlarini sadece ihtiyac duyuldugunda yukler
- 150K token → 2K token: **%98.7 azalma**

---

## 4. Onerilen Mimari: "MCP Gateway Extension"

### 4.1 Genel Bakis

```
┌─────────────────────────────────────────────────────────────┐
│                     pi CLI Agent Loop                        │
│                                                              │
│  System Prompt                                               │
│  ├── ... (standart prompt)                                   │
│  └── "MCP tools available. Use mcp_search to discover."     │
│                                                              │
│  Active Tools                                                │
│  ├── read, bash, edit, write (built-in)                     │
│  ├── mcp_search (always loaded — lightweight meta-tool)     │
│  ├── mcp_call (always loaded — executes any MCP tool)       │
│  └── [dynamically loaded MCP tools — only when needed]      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
│ MCP Registry │    │ Tool Catalog  │    │ MCP Client Pool  │
│ (config)     │    │ (cached meta) │    │ (connections)    │
│              │    │              │    │                  │
│ servers:     │    │ server→tools │    │ server→Client    │
│  - github    │    │  github:     │    │  github: ✓       │
│  - slack     │    │   - search   │    │  slack: (lazy)   │
│  - sentry    │    │   - create   │    │  sentry: (lazy)  │
│              │    │  slack:      │    │                  │
│              │    │   - send     │    │                  │
│              │    │   - list     │    │                  │
└─────────────┘    └──────────────┘    └──────────────────┘
```

### 4.2 Katmanli Mimari

#### Layer 1: MCP Registry (Configuration)

MCP server tanimlarinin tutuldugu konfigurasyon katmani.

```typescript
// ~/.pi/agent/mcp.json veya .pi/mcp.json (project-local)
{
  "servers": {
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" },
      "autoConnect": false,        // lazy connection
      "toolPolicy": "deferred"     // "deferred" | "always" | "disabled"
    },
    "sentry": {
      "transport": "http",
      "url": "https://mcp.sentry.io/sse",
      "headers": { "Authorization": "Bearer ${SENTRY_TOKEN}" },
      "autoConnect": false,
      "toolPolicy": "deferred"
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "autoConnect": true,         // eager connection
      "toolPolicy": "always"       // always in context
    }
  },
  "defaults": {
    "autoConnect": false,
    "toolPolicy": "deferred",
    "connectionTimeout": 30000,
    "idleTimeout": 300000          // 5 min idle → disconnect
  },
  "search": {
    "strategy": "fuzzy",           // "fuzzy" | "semantic" | "prefix"
    "maxResults": 5
  }
}
```

#### Layer 2: Tool Catalog (Metadata Cache)

Tum MCP server'lardan toplanan tool metadata'larinin lightweight cache'i.

```typescript
interface ToolCatalogEntry {
  serverName: string;
  toolName: string;
  qualifiedName: string;     // "github.search_repositories"
  description: string;
  parameterNames: string[];  // sadece isimler — full schema degil
  tags: string[];            // auto-extracted keywords
  tokenCost: number;         // estimated tokens for full definition
  lastUsed?: number;         // timestamp
  useCount: number;
}

interface ToolCatalog {
  entries: ToolCatalogEntry[];
  lastRefreshed: Record<string, number>;  // server → timestamp
  
  search(query: string, limit?: number): ToolCatalogEntry[];
  refresh(serverName?: string): Promise<void>;
  getFullDefinition(qualifiedName: string): Promise<MCPToolDefinition>;
}
```

**Tasarim kararlari:**
- Catalog **disk'e persist edilir** (`~/.pi/agent/cache/mcp-catalog.json`)
- Startup'ta disk'ten yuklenir, background'da refresh edilir
- Her entry ~50-100 byte (vs full definition ~500-2000 byte)
- 1000 tool icin catalog: ~100KB (vs full definitions: ~2MB / ~500K token)

#### Layer 3: MCP Client Pool (Connection Management)

```typescript
interface MCPClientPool {
  // Lazy connection — only connects when first tool from server is needed
  getClient(serverName: string): Promise<MCPClient>;
  
  // Disconnect idle servers
  disconnectIdle(maxIdleMs: number): void;
  
  // Full shutdown
  disconnectAll(): Promise<void>;
  
  // Connection status
  getStatus(): Map<string, "connected" | "disconnected" | "connecting" | "error">;
  
  // Listen to tools/list_changed notifications
  onToolsChanged(serverName: string, callback: () => void): void;
}
```

**Baglanti lifecycle:**
1. `disconnected` → Agent bir tool'a ihtiyac duyar
2. `connecting` → stdio process baslatilir veya HTTP baglantisinir kurulur
3. `connected` → Tool cagrilari yapilabilir
4. Idle timeout → `disconnected` (process kill / connection close)

#### Layer 4: Gateway Tools (LLM Interface)

Agent'in MCP ekosistemiyle etkilesim noktasi. Iki temel tool:

##### `mcp_search` — Lightweight Discovery Tool

```typescript
// Her zaman context'te. Minimal token maliyeti (~200 token).
{
  name: "mcp_search",
  description: "Search available MCP tools across all connected servers. " +
    "Returns tool names, descriptions, and server info. " +
    "Use this before calling MCP tools you haven't used yet.",
  parameters: {
    query: string,        // natural language or keyword search
    server?: string,      // optional: filter by server
    limit?: number        // default: 5
  }
}

// Ornek sonuc:
{
  content: [{
    type: "text",
    text: `Found 3 matching tools:

1. github.search_repositories
   Search GitHub repositories by query
   Server: github | Params: query, sort, order, per_page

2. github.search_code  
   Search code across GitHub repositories
   Server: github | Params: query, sort, order, per_page

3. sentry.search_issues
   Search Sentry issues by query
   Server: sentry | Params: query, project, sort`
  }]
}
```

##### `mcp_call` — Universal Execution Tool

```typescript
// Her zaman context'te. ~300 token.
{
  name: "mcp_call",
  description: "Call any MCP tool. First use mcp_search to find the tool, " +
    "then call it here with the qualified name and parameters.",
  parameters: {
    tool: string,         // qualified name: "github.search_repositories"
    params: object        // tool-specific parameters
  }
}
```

**Avantajlar:**
- Yalnizca 2 tool context'te (~500 token total)
- Agent herhangi bir MCP tool'u cagrirabilir
- Yeni server eklendiginde agent'in tool listesini degistirmeye gerek yok

**Dezavantajlar:**
- Extra bir LLM turn gerektirir (search → call)
- Parametre validation LLM'e birakiliyor

##### Alternatif: Dynamic Tool Injection

Bazi durumlarda `mcp_search` sonucu olarak tool'lari dogrudan agent'in tool listesine enjekte etmek daha verimli olabilir:

```typescript
// mcp_search sonucu: tool_reference benzeri mekanizma
// search sonrasi, bulunan tool'lar agent.setTools() ile eklenir
// bu turn boyunca agent dogrudan tool'u cagirabilir

pi.on("tool_result", async (event, ctx) => {
  if (event.toolName === "mcp_search" && !event.isError) {
    const foundTools = parseSearchResults(event);
    for (const tool of foundTools) {
      dynamicallyLoadTool(tool, ctx);  // agent tools'a ekle
    }
  }
});
```

Bu yaklasim Claude'un `tool_reference` mekanizmasina benzer: search sonrasi tool tanimlari **otomatik olarak** context'e eklenir.

### 4.3 Lifecycle: Bir MCP Tool Cagrisinin Anatomisi

```
Turn 1: User asks "What are the open Sentry issues for project X?"

1. Agent gorur: mcp_search + mcp_call toollari mevcut
2. Agent cagirir: mcp_search({ query: "sentry issues" })
3. Extension handler:
   a. ToolCatalog.search("sentry issues") → [sentry.search_issues, sentry.list_issues]
   b. Sonuclari dondurur (isim + description + param isimleri)
   c. [Opsiyonel] Bulunan tool'lari agent tool listesine inject eder
4. Agent cagirir: mcp_call({ tool: "sentry.list_issues", params: { project: "X", status: "open" } })
   VEYA (inject modunda): sentry.list_issues({ project: "X", status: "open" })
5. Extension handler:
   a. MCPClientPool.getClient("sentry") → lazy connect
   b. client.callTool("list_issues", params) → MCP protocol call
   c. Sonucu agent'a dondurur
6. Agent kullaniciya cevap verir

Turn 2+: Agent artik sentry tool'larini biliyor, dogrudan cagirabilir
  (eger inject modu kullaniliyorsa)

Idle timeout sonrasi: Sentry baglantisi kapanir, tool'lar listeden cikarilir
```

### 4.4 Tool Unloading Stratejisi

Unloading iki seviyede gerceklesir:

**Seviye 1: Tool Definition Unloading (Context Relief)**
- Bir tool belirli bir sure kullanilmazsa, definition context'ten cikarilir
- `turn_end` event'inde kullanilmayan tool'lar kontrol edilir
- Configurable threshold: N turn kullanilmadiysa unload

```typescript
interface UnloadPolicy {
  strategy: "turn-count" | "time-based" | "context-pressure";
  
  // turn-count: N turn kullanilmadiysa unload
  maxIdleTurns?: number;       // default: 3
  
  // time-based: N ms kullanilmadiysa unload
  maxIdleMs?: number;          // default: 300000 (5 min)
  
  // context-pressure: context usage %X'i astiginda en az kullanilanlari unload et
  contextThreshold?: number;   // default: 0.7 (70%)
}
```

**Seviye 2: Connection Unloading (Resource Relief)**
- Bir server'in hicbir tool'u aktif degilse, connection kapatilir
- stdio: process kill
- HTTP: connection close
- Configurable idle timeout

### 4.5 Context-Aware Loading

Agent'in context durumuna gore adaptive davranis:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const usage = ctx.getContextUsage();
  if (!usage) return;
  
  const pressure = usage.percent ?? 0;
  
  if (pressure > 80) {
    // Yuksek basinc: sadece mcp_search + mcp_call (proxy mode)
    unloadAllDynamicTools();
  } else if (pressure > 60) {
    // Orta basinc: son kullanilan 3 tool'u tut
    keepMostRecentTools(3);
  }
  // Dusuk basinc: tum yüklenmis tool'lari tut
});
```

---

## 5. Implementation Plani

### 5.1 Package Yapisi

Bu sistem bir **pi extension package** olarak implement edilmelidir:

```
pi-mcp/
  ├── package.json           # pi.extensions field
  ├── src/
  │   ├── index.ts           # Extension entry point
  │   ├── config/
  │   │   ├── types.ts       # Configuration types
  │   │   ├── loader.ts      # Load mcp.json
  │   │   └── schema.ts      # Config validation (TypeBox)
  │   ├── catalog/
  │   │   ├── types.ts       # ToolCatalogEntry, ToolCatalog
  │   │   ├── catalog.ts     # In-memory catalog with search
  │   │   ├── persistence.ts # Disk cache read/write
  │   │   └── search.ts      # Fuzzy/prefix search implementation
  │   ├── client/
  │   │   ├── pool.ts        # MCPClientPool — connection management
  │   │   ├── stdio.ts       # StdioTransport wrapper
  │   │   ├── http.ts        # StreamableHTTPTransport wrapper
  │   │   └── lifecycle.ts   # Connect/disconnect/idle management
  │   ├── tools/
  │   │   ├── mcp-search.ts  # mcp_search tool definition
  │   │   ├── mcp-call.ts    # mcp_call tool definition
  │   │   ├── mcp-servers.ts # mcp_servers tool (list/status)
  │   │   └── injector.ts    # Dynamic tool injection logic
  │   ├── unload/
  │   │   ├── policy.ts      # Unload policy engine
  │   │   └── tracker.ts     # Tool usage tracking
  │   └── prompt/
  │       └── mcp-context.ts # System prompt additions for MCP
  └── test/
      ├── catalog.test.ts
      ├── pool.test.ts
      ├── search.test.ts
      └── integration.test.ts
```

### 5.2 Dependency

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.26.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-coding-agent": ">=0.12.0"
  }
}
```

### 5.3 Kullanim

```bash
# Global install
pi install npm:pi-mcp

# Project-local
pi install npm:pi-mcp -l

# Veya manual
npm install pi-mcp
# .pi/extensions/ altina symlink veya package.json pi field
```

Konfigurasyon:
```bash
# Global: ~/.pi/agent/mcp.json
# Project: .pi/mcp.json (override/extend)
```

---

## 6. Alternatif Stratejiler: Karsilastirma

### Strateji A: Proxy Mode (mcp_search + mcp_call)

| Aspect | Detail |
|--------|--------|
| **Context cost** | ~500 token (2 tool definition) |
| **Accuracy** | Orta — agent parametre schemalarini gormez |
| **Latency** | +1 turn (search → call) |
| **Complexity** | Dusuk |
| **Provider-agnostic** | Evet — herhangi bir LLM ile calisir |

### Strateji B: Dynamic Injection (search → inject → direct call)

| Aspect | Detail |
|--------|--------|
| **Context cost** | ~500 + N*tool_size token (N: injected tool sayisi) |
| **Accuracy** | Yuksek — agent full schema gorur |
| **Latency** | +1 turn (ilk search icin), sonrasi direct |
| **Complexity** | Orta |
| **Provider-agnostic** | Evet |

### Strateji C: Hybrid (varsayilan oneri)

| Aspect | Detail |
|--------|--------|
| **Context cost** | Adaptive: dusuk basincta inject, yuksek basincta proxy |
| **Accuracy** | Yuksek (normal), Orta (basinc altinda) |
| **Latency** | Optimal |
| **Complexity** | Yuksek |
| **Provider-agnostic** | Evet |

**Oneri: Strateji C (Hybrid)** — context pressure'a gore strateji degistir:
- Dusuk pressure (<60%): Tool injection — full schema, direct call
- Orta pressure (60-80%): Sadece en cok kullanilan N tool inject, gerisi proxy
- Yuksek pressure (>80%): Pure proxy mode — yalnizca mcp_search + mcp_call

---

## 7. pi CLI Extension API Ihtiyaclari

Mevcut extension API'si bu implementasyon icin **buyuk olcude yeterlidir**, ancak bazi iyilestirmeler faydali olabilir:

### 7.1 Mevcut API ile Yapilabilenler

| İhtiyac | Mevcut API |
|---------|------------|
| Tool kaydetme | `pi.registerTool()` ✓ |
| Event dinleme | `pi.on("turn_end", ...)` ✓ |
| System prompt ekleme | `pi.on("before_agent_start", ...)` ile `systemPrompt` return ✓ |
| Context tracking | `ctx.getContextUsage()` ✓ |
| Tool listesi yonetimi | `pi.getActiveTools()` / `pi.setActiveTools()` ✓ |
| Session persistence | `pi.appendEntry()` ✓ |
| User notification | `ctx.ui.notify()` ✓ |
| Configuration | Extension flags + mcp.json dosyasi ✓ |
| Shutdown cleanup | `pi.on("session_shutdown", ...)` ✓ |

### 7.2 Faydali Olabilecek API Eklentileri

1. **`pi.registerDeferredTool(catalog)`** — Tool tanimini context'e eklemeden registry'de tutar, agent talep ettiginde inject eder. Bu, Claude'un `defer_loading` konseptinin pi karsiligi olur.

2. **`pi.on("turn_start")` icinde tool listesi degistirme** — Mevcut API'de `setActiveTools` var ama turn basinda cagrildiginda next LLM call'a yetisip yetismedigini garanti etmek zor. Turn basinda tool listesini guvenle degistiren bir hook faydali olur.

3. **Tool usage stats API** — Hangi tool'un hangi turn'de kullanildigini takip eden built-in mekanizma. Simdilik extension kendisi track edebilir.

Bu eklentiler **opsiyoneldir**. Mevcut API ile tam bir implementasyon mumkundur.

---

## 8. Guvenlik Degerlendirmeleri

### 8.1 MCP Server Guvenilirlik

- MCP server'lar arbitrary code calistirir (stdio: child process, HTTP: remote endpoint)
- Extension, tool cagrilarini `tool_call` event'i ile intercept edebilir
- Kullanici onay mekanizmasi eklenebilir (ozellikle write/destructive tool'lar icin)

### 8.2 Credential Management

- MCP server'lar genellikle API key/token gerektirir
- Environment variable interpolation desteklenmeli (`${GITHUB_TOKEN}`)
- Credential'lar **hicbir zaman** LLM context'ine girmemeli
- pi'nin mevcut auth storage'i kullanilabilir (`AuthStorage`)

### 8.3 Sandbox

- stdio MCP server'lar ayri process'lerde calisir — dogal izolasyon
- HTTP MCP server'lar remote — network izolasyonu
- Tool sonuclarinin boyut limitleri uygulanmali (buyuk response'lari truncate)

---

## 9. Performans Degerlendirmeleri

### 9.1 Token Ekonomisi

| Senaryo | Geleneksel | Proxy Mode | Hybrid |
|---------|-----------|------------|--------|
| 5 MCP server, 200 tool | ~150K token | ~500 token | ~2-5K token |
| Tek bir tool cagirma | 0 ek turn | +1 turn | +1 turn (ilk), 0 (sonrasi) |
| 10 tool aktif kullanim | ~150K token | ~500 token | ~8K token |

### 9.2 Latency

- MCP server connection: 100ms-2s (stdio), 200ms-5s (HTTP)
- Tool catalog refresh: 50-500ms per server
- Search: <5ms (in-memory fuzzy search)
- Lazy connection stratejisi ilk cagriyi yavaslatir ama sonrasini hizlandirir

### 9.3 Memory

- Tool catalog: ~100KB (1000 tool icin)
- MCP client pool: ~1-5MB per active connection
- Idle connection cleanup onemli

---

## 10. Sonuc ve Oneri

### Onerilen Yaklasim: Extension-Based Hybrid MCP Gateway

1. **Extension olarak implement et** — pi'nin "no MCP in core" felsefesine uygun
2. **Hybrid strateji** — context pressure'a gore proxy/injection arasinda gec
3. **Lazy connection** — server'lara sadece ihtiyac duyuldugunda baglan
4. **Disk-cached catalog** — startup'ta hizli tool kesfetme
5. **Configurable unload policy** — turn-count, time-based, veya context-pressure
6. **mcp.json konfigurasyon** — global + project-local override

### Uygulama Oncelikleri

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1** | Config loader + MCP client pool (stdio only) + mcp_search + mcp_call | 2-3 gun |
| **Phase 2** | Tool catalog + disk cache + search | 1-2 gun |
| **Phase 3** | Dynamic injection mode + unload policy | 2-3 gun |
| **Phase 4** | HTTP transport + context-aware hybrid mode | 1-2 gun |
| **Phase 5** | `/mcp` command (status, connect, disconnect) + UI integration | 1 gun |
| **Phase 6** | Test suite + documentation | 1-2 gun |

**Toplam: ~8-13 gun**

### Acik Sorular

1. **pi package olarak mi yoksa standalone extension olarak mi dagitilmali?** pi package (`pi install npm:pi-mcp`) en temiz yaklaşim, ancak standalone extension da mumkun.

2. **MCP Resources ve Prompts destegi eklenecek mi?** Bu rapor yalnizca Tools'a odaklanmaktadir. Resources (dosya/data) ve Prompts (template) icin ayri bir analiz yapilabilir. Resources, context injection icin kullanilabilir.

3. **Multi-provider tool search:** Claude'un native tool search'u yalnizca Claude API'de calisir. Diger provider'lar (OpenAI, Google) icin client-side search zorunludur. Bu implementasyondaki mcp_search tool'u zaten client-side oldugu icin provider-agnostic calisir.

4. **MCP Sampling/Elicitation:** MCP server'lar LLM sampling isteyebilir veya kullanicidan input talep edebilir. Bunlar pi'nin mevcut extension API'si ile desteklenebilir (`ctx.ui.input()`, `pi.sendUserMessage()`).
