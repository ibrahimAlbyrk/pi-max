# MCP Dynamic Tool Loading/Unloading Architecture Report

## Executive Summary

Bu rapor, pi CLI'ye MCP (Model Context Protocol) destegi eklenmesi icin **proxy-based tool discovery ve execution** mekanizmasi tasarimi uzerine derinlemesine bir analiz sunar. Claude'un Tool Search Tool yaklasimi, MCP protokolunun native `notifications/tools/list_changed` mekanizmasi ve Anthropic'in "Code Execution with MCP" yaklasimi incelenmis; pi CLI'nin mevcut extension/tool mimarisi uzerinde bu kavramlarin nasil uygulanabilecegi detaylandirilmistir.

---

## 1. Mevcut Durum Analizi

### 1.1 pi CLI Tool Mimarisi

pi CLI'nin tool sistemi su katmanlardan olusur:

```
Agent (pi-agent-core)
  └── ToolRegistry (single source of truth)
       ├── Builtin Tools: read, bash, edit, write, webfetch, websearch, ask_user
       ├── Extension Tools: pi.registerTool() ile kaydedilen toollar (registerExtension)
       └── SDK Custom Tools: createAgentSession({ customTools }) ile eklenenler (registerSdk)
```

**Kritik noktalar:**
- `ToolRegistry` sinifi tum tool metadata'sini yonetir (registration priority: SDK > extension > builtin, last-write-wins)
- `AgentSession._buildRuntime()` startup'ta tum tool'lari kaydeder, wrap eder ve `_toolRegistry` Map'ine yazar
- Tool wrapping pipeline: context injection → middleware → extension intercept → restriction wrapper
- `setActiveToolsByName()` pre-built `_toolRegistry` Map'inden secer ve system prompt'u rebuild eder
- Extension sistemi `wrapToolWithExtensions()` ile tool_call/tool_result event'lerini intercept edebilir
- `registerMiddleware()` ile tool bazinda middleware eklenebilir
- System prompt her tool degisikliginde yeniden olusturulur ve aktif tool listesini icerir

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

Agent'in **ihtiyac duyuldugunda** MCP tool'larini arayip proxy uzerinden cagirmasi. Boylece:
- Context'te yalnizca 2 sabit tool tanimi bulunur (mcp_search + mcp_call)
- Tool secim dogrulugu yuksek kalir (agent kendi tool'larindan sadece 2 MCP tool gorur)
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
│  └── mcp_call (always loaded — executes any MCP tool)       │
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
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "sentry": {
      "transport": "http",
      "url": "https://mcp.sentry.io/sse",
      "headers": { "Authorization": "Bearer ${SENTRY_TOKEN}" }
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  },
  "defaults": {
    "connectionTimeout": 30000,
    "idleTimeout": 300000          // 5 min idle → disconnect
  }
}
```

#### Layer 2: Tool Catalog (Metadata Cache)

Tum MCP server'lardan toplanan tool metadata'larinin lightweight cache'i.

```typescript
interface ToolCatalogEntry {
  serverName: string;
  toolName: string;
  qualifiedName: string;     // "github__search_repositories"
  description: string;
  parameterNames: string[];  // sadece isimler — full schema degil
}

interface ToolCatalog {
  entries: ToolCatalogEntry[];
  lastRefreshed: Record<string, number>;  // server → timestamp
  
  search(query: string, limit?: number): ToolCatalogEntry[];
  refresh(serverName?: string): Promise<void>;
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
2. `connecting` → stdio process baslatilir veya HTTP baglantisi kurulur
3. `connected` → Tool cagrilari yapilabilir
4. Idle timeout → `disconnected` (process kill / connection close)

#### Layer 4: Gateway Tools (LLM Interface)

Agent'in MCP ekosistemiyle etkilesim noktasi. Iki sabit tool:

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

1. github__search_repositories
   Search GitHub repositories by query
   Server: github | Params: query, sort, order, per_page

2. github__search_code  
   Search code across GitHub repositories
   Server: github | Params: query, sort, order, per_page

3. sentry__search_issues
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
    tool: string,         // qualified name: "github__search_repositories"
    params: object        // tool-specific parameters
  }
}
```

**Avantajlar:**
- Yalnizca 2 tool context'te (~500 token total)
- Agent herhangi bir MCP tool'u cagrirabilir
- Yeni server eklendiginde agent'in tool listesini degistirmeye gerek yok
- Provider-agnostic: herhangi bir LLM ile calisir
- pi'nin ToolRegistry sistemiyle tam uyumlu (startup'ta register, pre-wrap, bitti)

**Dezavantajlar:**
- Extra bir LLM turn gerektirir (search → call)
- Parametre validation LLM'e birakiliyor (MCP server hata donerse agent tekrar dener)

### 4.3 Lifecycle: Bir MCP Tool Cagrisinin Anatomisi

```
Turn 1: User asks "What are the open Sentry issues for project X?"

1. Agent gorur: mcp_search + mcp_call toollari mevcut
2. Agent cagirir: mcp_search({ query: "sentry issues" })
3. Extension handler:
   a. ToolCatalog.search("sentry issues") → [sentry__search_issues, sentry__list_issues]
   b. Sonuclari dondurur (isim + description + param isimleri)
4. Agent cagirir: mcp_call({ tool: "sentry__list_issues", params: { project: "X", status: "open" } })
5. Extension handler:
   a. MCPClientPool.getClient("sentry") → lazy connect
   b. client.callTool("list_issues", params) → MCP protocol call
   c. Sonucu agent'a dondurur
6. Agent kullaniciya cevap verir

Turn 2+: Agent mcp_search olmadan dogrudan mcp_call yapabilir
  (eger tool ismini onceki turn'den hatırliyorsa)

Idle timeout sonrasi: Sentry baglantisi kapanir.
Sonraki mcp_call: Otomatik yeniden baglanir.
```

### 4.4 Connection Lifecycle

Baglanti yonetimi yalnizca server seviyesinde gerceklesir:

- **Lazy connect**: Server'lara startup'ta baglanilmaz. Ilk tool cagrisi (veya catalog refresh) baglanti kurar.
- **Idle timeout**: Configurable suresi boyunca tool cagrisi yapilmayan server baglantisi otomatik kapatilir.
- **Auto-reconnect**: Kapatilmis baglanti, sonraki mcp_call'da otomatik yeniden kurulur.
- **Shutdown cleanup**: Session kapandiginda tum baglantilar temiz sekilde kapatilir.

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
  │   │   └── mcp-servers.ts # mcp_servers tool (list/status)
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

## 6. Strateji: Proxy Mode

Secilen strateji **Proxy Mode**'dur. Tum MCP tool erisimleri `mcp_search` + `mcp_call` uzerinden gerceklesir. Tool tanimlari hicbir zaman agent'in tool listesine eklenmez.

| Aspect | Detail |
|--------|--------|
| **Context cost** | ~500 token (2 tool definition) |
| **Accuracy** | Orta — agent parametre schemalarini gormez, ama mcp_search sonuclari parametre isimlerini icerir |
| **Latency** | +1 turn (ilk search icin), sonrasi agent tool ismini hatirliyorsa direct mcp_call |
| **Complexity** | Dusuk — pi'nin mevcut ToolRegistry sistemiyle tam uyumlu |
| **Provider-agnostic** | Evet — herhangi bir LLM ile calisir |

**Neden bu strateji:**
- pi'nin ToolRegistry'si startup'ta tum tool'lari pre-wrap eder. Runtime'da yeni tool eklenmesi icin `_buildRuntime()` tekrar cagrilmali ki bu agir bir islem.
- Proxy mode bu kisitlamaya takılmaz: sadece 2 sabit tool startup'ta kaydedilir, MCP tool'lari proxy uzerinden cagrilir.
- Context maliyeti her durumda ~500 token ile sabit kalir, MCP server/tool sayisindan bagimsiz.

---

## 7. pi CLI Extension API Uyumu

Mevcut extension API'si bu implementasyon icin **tam olarak yeterlidir**. Core'da degisiklik gerektirmez.

### 7.1 Mevcut API ile Yapilabilenler

| Ihtiyac | Mevcut API |
|---------|------------|
| Tool kaydetme | `pi.registerTool()` → ToolRegistry'ye `registerExtension()` ile girer ✓ |
| Event dinleme | `pi.on("turn_end", ...)`, `pi.on("session_start", ...)`, `pi.on("session_shutdown", ...)` ✓ |
| System prompt ekleme | `pi.on("before_agent_start", ...)` ile `systemPrompt` return ✓ |
| Tool interception | `pi.on("tool_call", ...)` / `pi.on("tool_result", ...)` via wrapToolWithExtensions ✓ |
| User notification | `ctx.ui.notify()` ✓ |
| Configuration | Extension flags + mcp.json dosyasi ✓ |
| Shutdown cleanup | `pi.on("session_shutdown", ...)` ✓ |

### 7.2 ToolRegistry Uyumluluk Notu

Proxy mode, ToolRegistry'nin pre-wrapping modeliyle **tam uyumlu**dur:
- `mcp_search` ve `mcp_call` extension loading sirasinda `pi.registerTool()` ile kaydedilir
- `_buildRuntime()` bunlari `runner.getAllRegisteredTools()` ile toplayip registry'ye ekler
- Pre-wrap pipeline uygulanir (context injection → middleware → extension intercept → restriction wrapper)
- Sonuc: iki tool `_toolRegistry` Map'inde hazir bekler

Runtime'da hicbir tool ekleme/cikarma islemi gerekmez. Tum MCP tool erisimleri `mcp_call` proxy'si uzerinden gerceklesir.

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

| Senaryo | Geleneksel (tum tool'lar context'te) | Proxy Mode |
|---------|--------------------------------------|------------|
| 5 MCP server, 200 tool | ~150K token | ~500 token |
| Tek bir tool cagirma | 0 ek turn | +1 turn (search) |
| 10 tool aktif kullanim | ~150K token | ~500 token |

Proxy mode'un **sabit ~500 token** maliyeti, MCP server/tool sayisindan tamamen bagimsizdir.

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

### Onerilen Yaklasim: Extension-Based Proxy MCP Gateway

1. **Extension olarak implement et** — pi'nin "no MCP in core" felsefesine uygun
2. **Proxy mode** — mcp_search + mcp_call ile sabit ~500 token context maliyeti
3. **Lazy connection** — server'lara sadece ihtiyac duyuldugunda baglan
4. **Disk-cached catalog** — startup'ta hizli tool kesfetme
5. **mcp.json konfigurasyon** — global + project-local override

### Uygulama Oncelikleri

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1** | Config loader + MCP client pool (stdio + HTTP) + Tool catalog + disk cache + mcp_search + mcp_call | 3-5 gun |
| **Phase 2** | `/mcp` command (status, connect, disconnect) + UI integration | 1 gun |
| **Phase 3** | Test suite + documentation | 1-2 gun |

**Toplam: ~5-8 gun**

### Acik Sorular

1. **pi package olarak mi yoksa standalone extension olarak mi dagitilmali?** pi package (`pi install npm:pi-mcp`) en temiz yaklasim, ancak standalone extension da mumkun.

2. **MCP Resources ve Prompts destegi eklenecek mi?** Bu rapor yalnizca Tools'a odaklanmaktadir. Resources (dosya/data) ve Prompts (template) icin ayri bir analiz yapilabilir. Resources, context injection icin kullanilabilir.

3. **Multi-provider tool search:** Claude'un native tool search'u yalnizca Claude API'de calisir. Diger provider'lar (OpenAI, Google) icin client-side search zorunludur. Bu implementasyondaki mcp_search tool'u zaten client-side oldugu icin provider-agnostic calisir.

4. **MCP Sampling/Elicitation:** MCP server'lar LLM sampling isteyebilir veya kullanicidan input talep edebilir. Bunlar pi'nin mevcut extension API'si ile desteklenebilir (`ctx.ui.input()`, `pi.sendUserMessage()`).
