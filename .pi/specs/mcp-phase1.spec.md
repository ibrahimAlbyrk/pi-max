# MCP Gateway Extension — Phase 1 Spec

## 1. Amaç

pi CLI'ye MCP (Model Context Protocol) destegi ekleyen bir extension gelistirmek. Extension, proxy pattern kullanarak iki sabit tool (mcp_search ve mcp_call) uzerinden agent'in herhangi bir MCP server'daki tool'lara erismesini saglar. Tool tanimlari context'e eklenmez; agent ihtiyac duyuldugunda arar ve cagrir. Bu yaklasim cache-friendly'dir, provider-agnostic calisir ve context tuketimini minimize eder.

---

## 2. Kapsam

Phase 1 asagidakileri icerir:

- MCP server konfigurasyon sistemi (mcp.json)
- MCP client baglanti yonetimi (stdio ve HTTP transport)
- Tool catalog: tum server'lardan tool metadata toplama ve cache'leme
- mcp_search tool: agent'in tool aramasini saglayan meta-tool
- mcp_call tool: agent'in herhangi bir MCP tool'u proxy uzerinden cagirmasini saglayan meta-tool
- Baglanti lifecycle yonetimi (lazy connect, idle disconnect, shutdown cleanup)
- Hata yonetimi ve kullanici bildirimleri
- Sistem promptuna MCP bilgilendirme eki

Phase 1 **icermeyen** konular:

- Dynamic tool injection (tool tanimlarini agent tool listesine ekleme)
- MCP Resources ve Prompts destegi
- MCP Sampling ve Elicitation destegi
- OAuth authentication flow
- Semantic/embedding-based tool search
- Tool usage analytics ve smart preloading

---

## 3. Dagitim Bicimi

Extension, pi'nin standart extension mekanizmasi ile dagitilir. Kullanici extension'i su yollardan birine koyarak aktif eder:

- Proje-lokal: `.pi/extensions/mcp/index.ts` (veya `.pi/extensions/mcp.ts`)
- Global: `~/.pi/agent/extensions/mcp/index.ts`
- Manuel: `pi -e ./mcp-extension/index.ts`
- Paket olarak: ileride `pi install npm:pi-mcp` ile (Phase 1 disinda)

Extension, pi'nin mevcut API'sini kullanir: `pi.registerTool()`, `pi.on()`, `ctx.ui`, `ctx.getContextUsage()`. Core'da degisiklik gerektirmez.

---

## 4. Bagimliliklar

Extension, MCP TypeScript SDK'nin client paketini kullanir. V2 henuz pre-alpha oldugu icin v1.x kullanilir (production-recommended). Paket adi: `@modelcontextprotocol/sdk` (v1.x). Peer dependency olarak `zod` gerekir (v1 zod v3 kullanir).

Extension ayrica pi'nin kendi paketlerini kullanir: `@mariozechner/pi-coding-agent` (extension API tipleri) ve `@sinclair/typebox` (tool parameter schemalari). Bunlar pi tarafindan runtime'da saglenir (virtualModules/alias mekanizmasi).

---

## 5. Konfigurasyon

### 5.1 Konfigurasyon Dosyasi

Konfigurasyon `mcp.json` dosyasindan okunur. Iki seviyeli hiyerarsi:

- **Proje-lokal:** `.pi/mcp.json` — bu proje icin gecerli server tanimlari
- **Global:** `~/.pi/agent/mcp.json` — tum projelerde gecerli server tanimlari

Her iki dosya da varsa, birlestirme kurali: proje-lokal server tanimlari global tanimlari override eder (ayni isimli server varsa proje-lokal kazanir). Proje-lokal dosyada tanimlanmayan server'lar global dosyadan gelir.

### 5.2 Server Tanimi

Her MCP server tanimi su alanlari icerir:

**Zorunlu alanlar:**
- **name**: Server'in benzersiz tanimlayici ismi (ornek: "github", "sentry"). Config dosyasinda key olarak kullanilir.
- **transport**: Baglanti tipi. Iki deger alir: "stdio" veya "http".

**stdio transport icin zorunlu:**
- **command**: Calistirilacak komut (ornek: "npx", "node", "python").
- **args**: Komut argumanlari listesi (ornek: ["-y", "@modelcontextprotocol/server-github"]).

**http transport icin zorunlu:**
- **url**: MCP server'in HTTP endpoint'i (ornek: "https://mcp.sentry.io/sse").

**Opsiyonel alanlar (tum transport'lar icin):**
- **env**: Server process'ine veya HTTP isteklerine iletilecek environment variable'lar. Deger olarak `${ENV_VAR}` syntax'i desteklenir — runtime'da process.env'den resolve edilir.
- **headers**: HTTP isteklerine eklenecek header'lar (sadece http transport). env ile ayni interpolasyon destegi.
- **disabled**: Boolean. true ise bu server tamamen ignore edilir. Varsayilan: false.
- **connectionTimeout**: Baglanti kurma icin maksimum bekleme suresi (milisaniye). Varsayilan: defaults'tan gelir.
- **idleTimeout**: Kullanilmayan baglantinin otomatik kapatilma suresi (milisaniye). Varsayilan: defaults'tan gelir.

### 5.3 Global Defaults

Config dosyasinda `defaults` alani ile tum server'lar icin varsayilan degerler tanimlanabilir:

- **connectionTimeout**: Varsayilan 30000 (30 saniye).
- **idleTimeout**: Varsayilan 300000 (5 dakika).

Bireysel server taniminda belirtilen degerler defaults'u override eder.

### 5.4 Environment Variable Interpolasyonu

Konfigurasyon degerlerinde `${VAR_NAME}` pattern'i desteklenir. Runtime'da `process.env[VAR_NAME]` ile resolve edilir. Resolve edilemeyen degiskenler icin extension startup'ta uyari verir ama server'i devre disi birakmaz — baglanti aninda hata olusursa o zaman bildirim yapilir.

### 5.5 Konfigurasyon Validasyonu

Config dosyasi yuklenirken su kontroller yapilir:
- JSON parse hatasi → extension startup'ta uyari, MCP devre disi
- Bilinmeyen alanlar → uyari, ignore
- Zorunlu alan eksik (transport, command/url) → ilgili server skip, uyari
- Ayni isimli server tekrari → proje-lokal kazanir, uyari
- Transport degeri "stdio" veya "http" degilse → server skip, uyari

Validasyon hatalari kullaniciyi engellemez; hatali server'lar skip edilir, gecerli olanlar normal calisir.

---

## 6. MCP Client Pool

### 6.1 Sorumluluk

Client Pool, MCP server baglantilarin yasam dongusu yonetiminden sorumludur. Her server icin bir MCP Client instance'i olusturur, baglantiyi kurar, idle takibi yapar ve kapatma islemlerini yonetir.

### 6.2 Baglanti Stratejisi: Lazy Connect

Server'lara startup'ta baglanilmaz. Baglanti, ilgili server'daki bir tool ilk kez arandiginda veya cagrildiginda kurulur. Bu, kullanilmayan server'lar icin gereksiz process/baglanti olusturmayi onler.

Istisna: Tool catalog'un ilk doldurulmasi (startup'ta veya ilk mcp_search cagrisinda) tum server'lara geciçi baglanti gerektirir. Bu islem background'da yapilir (asagida detaylandirildi).

### 6.3 Baglanti Durumlari

Her server su durumlardan birinde olabilir:

- **disconnected**: Baglanti yok. Varsayilan baslangic durumu.
- **connecting**: Baglanti kuruluyor (process spawn veya HTTP handshake).
- **connected**: Baglanti aktif. Tool cagrilari yapilabilir.
- **error**: Baglanti kurulamadi veya koptu. Hata mesaji saklanir.

### 6.4 stdio Transport Baglanti Detaylari

- Child process spawn edilir (command + args + env ile).
- stdin/stdout uzerinden JSON-RPC iletisimi kurulur.
- Process'in stderr'i log amacli capture edilir (kullaniciya gosterilmez, hata debug icin saklanir).
- Baglanti kapatildiginda: once graceful close (stdin kapat), timeout sonrasi SIGTERM, sonra SIGKILL.

### 6.5 HTTP Transport Baglanti Detaylari

- StreamableHTTP transport kullanilir.
- URL + headers ile baglanti kurulur.
- SSE fallback: Eger StreamableHTTP basarisiz olursa, SSE transport denenir (legacy server destegi).
- Baglanti kapatildiginda: once session terminate, sonra close.

### 6.6 Idle Timeout

Her basarili tool cagrisindan sonra idle timer sifirlanir. Server'a `idleTimeout` suresi boyunca hicbir istek yapilmazsa baglanti otomatik kapatilir. Durum `disconnected`'a doner. Sonraki tool cagrisi yeni baglanti kurar.

### 6.7 Yeniden Baglanti

Baglanti koptuktunda (process crash, network hatasi) otomatik yeniden baglanti denenmez. Sonraki tool cagrisi yeni baglanti kurar. Bu, karmasik retry logic'i onler ve davranisi tahmin edilebilir kilar.

### 6.8 Shutdown

Extension `session_shutdown` event'i aldiginda, tum aktif baglantilari kapatir:
- Tum idle timer'lar iptal edilir
- Tum client'lar close edilir (stdio: process kill, HTTP: session terminate)
- Catalog cache'i disk'e yazilir

---

## 7. Tool Catalog

### 7.1 Sorumluluk

Tool Catalog, tum bagli MCP server'lardaki tool'larin hafif metadata'sini tutar. Tam tool tanimlari (full JSON Schema) yerine yalnizca arama icin gereken minimum bilgiyi saklar. Bu, bellekte ve diskte minimal yer kaplar.

### 7.2 Catalog Entry Yapisi

Her tool icin su bilgiler saklanir:

- **serverName**: Tool'un ait oldugu MCP server ismi.
- **toolName**: Tool'un MCP server'daki ismi (ornek: "search_repositories").
- **qualifiedName**: Tam nitelendirilmis isim: "serverName__toolName" (cift alt cizgi ayirici). Bu, mcp_call'da kullanilan benzersiz tanimlayicidir.
- **description**: Tool'un MCP server'dan gelen aciklamasi. Oldugu gibi saklanir.
- **parameterSummary**: Parametre isimlerinin listesi (yalnizca isimler, tip/schema bilgisi yok). Agent'in arama sonuclarinda hangi parametrelerin gerektigini gormesi icin.

### 7.3 Catalog Doldurma

Catalog su durumlarda doldurulur/guncellenir:

**Baslangic (Startup):**
Extension `session_start` event'i aldiginda, konfigurasyondaki tum server'lara baglanir, `listTools` cagrisini yapar, catalog'u doldurur ve baglantiyi kapatir (idle timeout'a birakmak yerine hemen kapatir — bu sadece metadata toplama icin). Bu islem background'da yapilir; basarisiz olan server'lar icin catalog bos kalir ve uyari verilir. Disk cache varsa once o yuklenir, sonra background'da refresh baslar.

**Manuel Refresh:**
mcp_search tool'una ozel bir parametre ile ("refresh" flagi) catalog yeniden doldurulabilir. Bu, yeni tool eklendiginde veya server guncellediginde kullanilir.

**tools/list_changed Bildirimi:**
Eger bir MCP server `notifications/tools/list_changed` gonderdiyse ve o server'a halihazirda baglanti varsa, catalog o server icin otomatik guncellenir.

### 7.4 Disk Cache

Catalog, disk'e persist edilir:

- **Konum:** `~/.pi/agent/cache/mcp-catalog.json`
- **Format:** JSON. Server ismine gore gruplanmis tool entry'leri + her server icin son refresh timestamp'i.
- **Yuklenme:** Extension startup'ta once disk cache'i yukler. Bu, server'lara baglanmadan once bile mcp_search'un calismasini saglar (stale ama kullanilabilir sonuclar).
- **Gecerlilik:** Disk cache'in yasi kontrol edilmez; her zaman yuklenir. Background refresh ile guncellenir.
- **Yazma:** Her basarili catalog refresh sonrasi (startup veya manuel) disk'e yazilir.
- **Hata:** Disk yazma/okuma hatasi sessizce ignore edilir; catalog yalnizca bellekte calisir.

### 7.5 Arama

Catalog uzerinde fuzzy search yapilir. Arama su alanlarda gerceklesir:

- qualifiedName
- description
- parameterSummary (parametre isimleri)

Arama algoritmasi: case-insensitive substring eslestirme + basit skor hesaplama. Skor kriterleri:

- Tool ismiyle tam eslesme (en yuksek skor)
- Tool ismi icinde substring eslesme
- Description icinde substring eslesme
- Parametre isimlerinde eslesme (en dusuk skor)

Sonuclar skora gore sirali dondurulur. Varsayilan limit: 5 sonuc.

---

## 8. mcp_search Tool

### 8.1 Sorumluluk

Agent'in MCP ekosistemindeki tool'lari kefsetmesini saglayan meta-tool. Her zaman aktif; context maliyeti dusuk.

### 8.2 Parametreler

- **query** (zorunlu, string): Aranacak terim. Dogal dil veya anahtar kelime olabilir. Ornek: "github issues", "send slack message", "database query".
- **server** (opsiyonel, string): Sonuclari belirli bir server ile sinirla. Server ismi ile eslestirilir.
- **refresh** (opsiyonel, boolean): true ise aramayi yapmadan once catalog'u tum server'lardan yeniden doldurur. Varsayilan: false.

### 8.3 Donus Formati

Tool, text content olarak insan-okunabilir bir sonuc listesi dondurur. Her sonuc icin:

- Qualified name (mcp_call'da kullanilacak isim)
- Description (MCP server'dan gelen aciklama)
- Server ismi
- Parametre isimleri listesi

Sonuc bulunamazsa: "No matching tools found." mesaji dondurulur ve mevcut server listesi bilgi olarak eklenir.

Catalog henuz doldurulmamissa (startup henuz tamamlanmamis): once catalog doldurma islemi beklenir, sonra arama yapilir.

### 8.4 Hata Durumlari

- Konfigurason dosyasi bulunamadi veya bos → "No MCP servers configured." mesaji.
- Tum server'lara baglanti basarisiz → sonuclari disk cache'ten dondur + uyari mesaji ekle.
- Tek bir server'a baglanti basarisiz → diger server'larin sonuclarini dondur + basarisiz server'i belirt.

---

## 9. mcp_call Tool

### 9.1 Sorumluluk

Agent'in kesfettigi herhangi bir MCP tool'u cagirmasini saglayan proxy tool. Her zaman aktif; context maliyeti dusuk.

### 9.2 Parametreler

- **tool** (zorunlu, string): Cagrilacak tool'un qualified name'i. Format: "serverName__toolName". Bu isim mcp_search sonuclarindan gelir.
- **arguments** (zorunlu, object): Tool'a iletilecek parametreler. Serbest form JSON objesi — validation MCP server tarafinda yapilir.

### 9.3 Calisma Akisi

1. Qualified name parse edilir → server name ve tool name ayristirilir.
2. Server name konfigurasyonda kontrol edilir. Yoksa hata.
3. Client Pool'dan ilgili server'in client'i istenir. Baglanti yoksa lazy connect yapilir.
4. MCP SDK uzerinden `callTool` cagrisi yapilir (tool name + arguments).
5. Sonuc alindi:
   - Basarili (isError: false) → tool sonucu text content olarak dondurulur.
   - Tool hatasi (isError: true) → hata mesaji content olarak dondurulur, pi tool result'u da isError olarak isaretlenir.
   - Protokol hatasi (exception) → hata mesaji dondurulur, isError: true.

### 9.4 Sonuc Formatlama

MCP tool sonucu `content` array'i icerir. Her content item `text` veya `image` tipinde olabilir.

- **text content**: Oldugu gibi pi tool result content'ine eklenir.
- **image content**: base64 data + mimeType ile pi'nin ImageContent formatina donusturulur.
- **embedded resource content**: text olarak eklenir (URI + icerik).

Sonuc cok buyukse (configurable threshold, varsayilan 50KB): truncate edilir ve truncation uyarisi eklenir. Bu, MCP server'larin beklenmedik buyuklukte sonuc dondurdugu durumlarda context'i korur.

### 9.5 Timeout

Her mcp_call cagrisi icin timeout uygulanir. Varsayilan: 60 saniye. Bu, MCP SDK'nin kendi timeout mekanizmasi uzerinden saglanir. Timeout durumunda agent'a bilgilendirici hata mesaji dondurulur.

### 9.6 Hata Durumlari

- Qualified name gecersiz format → "Invalid tool name format. Expected: serverName__toolName"
- Server konfigurasyonda yok → "Unknown MCP server: {name}. Available servers: ..."
- Baglanti kurulamadi → "Failed to connect to MCP server '{name}': {error}"
- Tool MCP server'da bulunamadi → "Tool '{toolName}' not found on server '{serverName}'"
- Tool execution hatasi → MCP server'in dondurdugu hata mesaji iletilir
- Timeout → "MCP tool call timed out after {N}ms"

---

## 10. System Prompt Entegrasyonu

### 10.1 Yaklasim

Extension, `before_agent_start` event handler'i ile system prompt'a MCP bilgilendirme metni ekler. Bu metin agent'a MCP tool'larin varligini ve nasil kullanilacagini anlatir.

### 10.2 Eklenen Metin

System prompt'a eklenen metin su bilgileri icerir:

- MCP tool ekosisteminin mevcut oldugu
- Hangi MCP server'larin konfigure edildigi (isim listesi + kisa aciklamalar — eger server instructions mevcutsa)
- mcp_search tool'unun ne ise yaradigi ve nasil kullanilacagi
- mcp_call tool'unun ne ise yaradigi ve nasil kullanilacagi
- Qualified name formati (serverName__toolName)
- Agent'in once arama yapip sonra cagirmasi gerektigi yonergesi

Bu metin sabit bir template olarak extension icinde tanimlanir. Server listesi runtime'da konfigurasyondan doldurulur.

### 10.3 Kosullu Ekleme

- Hicbir MCP server konfigure edilmemisse veya tumu disabled ise: system prompt'a hicbir sey eklenmez.
- En az bir aktif server varsa: yukaridaki metin eklenir.

---

## 11. Extension Lifecycle

### 11.1 Startup Akisi

1. Extension factory fonksiyonu cagrilir.
2. mcp_search ve mcp_call tool'lari `pi.registerTool()` ile kaydedilir.
3. Event handler'lar baglanir.
4. Extension factory doner (senkron). Async islemler henuz baslamaz.

### 11.2 Session Start

`session_start` event'i alindikta:
1. Konfigurasyon dosyalari okunur ve merge edilir (proje-lokal + global).
2. Validasyon yapilir; uyarilar `ctx.ui.notify()` ile gosterilir.
3. Disk cache yuklenir (varsa). Catalog bellege alinir.
4. Background'da catalog refresh baslatilir (tum server'lara baglanip listTools cagirma). Bu async olarak calisir; mcp_search cagrildiginda henuz tamamlanmamissa beklenir.

### 11.3 Her Turn Oncesi

`before_agent_start` event'inde:
1. System prompt'a MCP bilgilendirme metni eklenir (kosula bagli).

### 11.4 Shutdown

`session_shutdown` event'inde:
1. Tum idle timer'lar iptal edilir.
2. Tum aktif MCP client baglantilari kapatilir.
3. Catalog cache disk'e yazilir.
4. Devam eden background islemler (catalog refresh) iptal edilir.

### 11.5 Reload

Extension `/reload` ile yeniden yuklendiginde standart extension lifecycle'i isler: eski instance shutdown alir, yeni instance startup'tan baslar. Client Pool ve Catalog sifirdan olusturulur.

---

## 12. Hata Yonetimi

### 12.1 Genel Prensip

Extension, hicbir durumda pi'nin ana isleyisini bozmamalir. MCP ile ilgili tum hatalar yakalanir ve anlamli mesajlarla agent'a veya kullaniciya iletilir.

### 12.2 Startup Hatalari

- Config dosyasi parse edilemezse: `ctx.ui.notify()` ile uyari, MCP tool'lari kayitli ama islevsiz (search "no servers configured" doner, call hata doner).
- Disk cache okunamazsa: sessizce ignore, bos catalog ile basla.
- Hicbir server'a baglanilamazsa (catalog refresh): disk cache varsa onu kullan, yoksa bos catalog.

### 12.3 Runtime Hatalari

- Server baglantisi koptu: durum "error"a gecer, sonraki call'da yeniden baglanma denenir.
- Tool call MCP hatasi: hata mesaji agent'a dondurulur (isError: true content olarak).
- Tool call timeout: timeout mesaji dondurulur.
- Beklenmedik exception: yakalanir, genel hata mesaji dondurulur, stack trace log'a yazilir.

### 12.4 Kullanici Bildirimleri

Asagidaki durumlar `ctx.ui.notify()` ile kullaniciya bildirilir (agent'a degil):

- MCP server baglanti hatasi (warning seviyesi)
- Config validasyon uyarilari (warning seviyesi)
- Catalog refresh tamamlanma (info seviyesi, sadece startup'ta)

---

## 13. Dosya Yapisi

Extension su dizin yapisiyla organize edilir:

- **index.ts**: Extension entry point. Factory fonksiyonu export eder. Tool kayitlarini ve event handler baglamalarini yapar.
- **config.ts**: Konfigurasyon yukleme, merge, validasyon ve environment variable interpolasyonu.
- **pool.ts**: MCP Client Pool. Server baglanti lifecycle yonetimi, lazy connect, idle tracking, shutdown.
- **catalog.ts**: Tool Catalog. Bellekte metadata tutma, fuzzy search, disk cache okuma/yazma.
- **tools/search.ts**: mcp_search tool tanimi ve execute fonksiyonu.
- **tools/call.ts**: mcp_call tool tanimi ve execute fonksiyonu.
- **prompt.ts**: System prompt'a eklenecek MCP bilgilendirme metninin olusturulmasi.
- **types.ts**: Tum dahili tip tanimlari (config, catalog entry, pool state, vb.).
- **constants.ts**: Varsayilan degerler (timeout'lar, limitler, qualified name ayirici).

---

## 14. Test Stratejisi

### 14.1 Unit Testler

- **Config:** JSON parse, merge (global + lokal), validasyon, env var interpolasyon, edge case'ler (bos dosya, gecersiz JSON, eksik alanlar).
- **Catalog:** Entry ekleme, silme, search (eslesme, siralama, limit, bos sonuc), disk cache read/write, stale cache davranisi.
- **Pool:** Lazy connect davranisi, idle timeout tetiklenmesi, shutdown sırası, hata durumunda state gecisi, baglanti tekrari.
- **Search tool:** Parametre validasyonu, catalog entegrasyonu, refresh flagi, bos catalog, hata mesajlari.
- **Call tool:** Qualified name parsing, basarili cagri, isError cagri, timeout, baglanti hatasi, bilinmeyen server, bilinmeyen tool, sonuc truncation.
- **Prompt:** Server listesiyle metin olusturma, bos server listesi, disabled server'larin filtrelenmesi.

### 14.2 Entegrasyon Testleri

- Gercek bir MCP server ile end-to-end akis: search → call → sonuc dogrulama.
- Test icin MCP SDK'nin in-memory transport'u kullanilabilir (InMemoryTransport).
- Bir test MCP server'i olusturulur (birkac basit tool ile), extension bu server'a baglanir, tool arar ve cagrir.

---

## 15. Kisitlar ve Bilinen Limitasyonlar

- **Parametre validasyonu agent'a birakilir.** mcp_call, arguments objesini dogrudan MCP server'a iletir. Schema validasyonu MCP server tarafinda yapilir. Agent yanlis parametre gonderdiyse MCP server'in hata mesaji agent'a dondurulur; agent bu hatadan ogrenip tekrar dener.
- **Tool listesi degisiklikleri cache invalidation gerektirir.** Eger bir MCP server'a yeni tool eklendiyse, agent bunu ancak catalog refresh sonrasi gorebilir (mcp_search refresh parametresi veya sonraki session startup).
- **Buyuk sonuclar truncate edilir.** MCP server'larin dondurdugu buyuk payload'lar context'i korumak icin kesilir. Bu, bazi durumlarda eksik bilgiye yol acabilir.
- **Paralel tool cagrilari.** mcp_call side effects olarak isaretlenir (sideEffects: true). Bu, pi'nin ayni anda birden fazla mcp_call'i paralel calistirmasini engeller. Bu, MCP server'larin concurrent cagrılara hazir olmamasina karsi koruma saglar.
- **Auth yalnizca env var + headers ile desteklenir.** OAuth flow destegi Phase 1'de yoktur. Token gerektiren server'lar icin kullanici token'i env var olarak saglar, extension bunu header'a koyar.

---

## 16. Basari Kriterleri

Phase 1 asagidaki durumlarin hepsinde dogru calismalidır:

1. Kullanici `.pi/mcp.json` dosyasinda bir stdio MCP server tanimlar. pi baslatilir. Agent "github'daki issue'lari listele" dediginde mcp_search ile tool bulur, mcp_call ile cagrir, sonucu kullaniciya dondurur.

2. Birden fazla MCP server tanimli (ornek: github + filesystem). Agent iki server'daki tool'lari arayabilir ve cagirabilir, server'lar arasinda gecis yapabilir.

3. MCP server'a baglantilamadigi durumda (process bulunamadi, network hatasi) agent anlamli hata mesaji alir ve diger tool'larini kullanmaya devam eder.

4. Uzun sure MCP tool kullanilmadiginda (idle timeout), baglanti otomatik kapanir. Sonraki kullanumda otomatik yeniden baglanir.

5. pi kapandiginda tum MCP processleri temiz sekilde sonlandirilir (orphan process kalmaz).

6. Ayni session icinde birden fazla mcp_search + mcp_call dongusu sorunsuz calisir.

7. Cache bosken (ilk calistirma) ve cache doluyken (sonraki calistirmalar) mcp_search dogru sonuc dondurur.

8. HTTP transport ile remote MCP server'a baglanip tool cagirabilir.

---

## 17. Qualified Name Formati

MCP ekosistemine farkli server'lardan gelen tool'lar ayni isme sahip olabilir (ornek: iki server'da da "search" tool'u olabilir). Bu nedenle benzersiz bir qualified name formati kullanilir:

**Format:** `{serverName}__{toolName}` (cift alt cizgi ayirici)

**Neden cift alt cizgi:**
- Tek alt cizgi MCP tool isimlerinde yaygin (ornek: "search_repositories")
- Cift alt cizgi MCP tool isimlerinde neredeyse hic kullanilmaz
- Parse etmesi kolay: ilk `__` occurrence'i ayirici olarak kullanilir

**Parse kurali:** String'deki ilk `__` occurrence'ini bul. Solundaki kisim server name, sagindaki kisim tool name. Bu, tool isimlerinde `__` bulunmasi durumunda bile dogru calişır (server isimlerinde `__` yasaklanir — config validasyonunda kontrol edilir).

---

## 18. Sonuc Boyutu Yonetimi

MCP server'lar onceden tahmin edilemeyen boyutta sonuc dondurabilir. Context'i korumak icin:

- **Varsayilan limit:** 50KB (pi'nin kendi tool'lariyla tutarli).
- **Truncation stratejisi:** Sonuc limiti asarsa, son kisim kesilir ve sonuna truncation bildirimi eklenir: kac byte kesildigini ve toplam boyutu belirtir.
- **Image content:** Boyut limitine dahil edilmez; oldugu gibi iletilir (pi'nin kendi image handling'i devreye girer).
- **Konfigurasyonda override:** mcp.json'da `defaults.maxResultSize` ile degistirilebilir.
