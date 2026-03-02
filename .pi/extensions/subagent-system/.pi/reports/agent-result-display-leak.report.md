# Subagent Sonucu Ana Conversation'a Sızması — Kök Neden Analizi

**Tarih:** 1 Mart 2026  
**Sorun:** Subagent tamamlandığında çıktısı ana agent'ın conversation'ında doğrudan gösteriliyor. Ana agent "worker" durumunda gözüküyor ve sanki subagent'in çıktısını kendi yazıyormuş gibi davranıyor.

---

## Kesin Teşhis

**Sorun, `onAgentTaskDone()` → `pi.sendMessage()` → `agent.prompt()` / `agent.followUp()` → `agentLoop` zincirinde.**

Subagent tamamlandığında çıktısı `pi.sendMessage({display: true}, {triggerTurn: true, deliverAs: "followUp"})` ile gönderiliyor. Bu mesaj, pi-agent-core'un `agentLoop` içinde `message_start` event'i olarak emit ediliyor — bu da TUI'da render edilmesine VE LLM'e tam çıktı olarak gitmesine neden oluyor. Tüm bunlar ana agent'ın tek bir streaming oturumu (worker state) içinde gerçekleşiyor.

---

## Tam Akış (Trace)

### Senaryo A: Ana Agent Boşta (Not Streaming)

```
1. Ana agent turn'ını bitirir ("Araştırma başlatıldı, bekliyorum...")
2. isStreaming = false

3. Subagent tamamlanır → onAgentTaskDone(handle, output)
4. pi.sendMessage({content: fullOutput, display: true}, {triggerTurn: true, deliverAs: "followUp"})
5. → sendCustomMessage() çalışır:
     - deliverAs === "nextTurn"? → Hayır
     - isStreaming? → Hayır (false)
     - triggerTurn? → Evet
     ➜ await this.agent.prompt(appMessage)  // ← Yeni turn başlatır!

6. agent.prompt(appMessage) → agent._runLoop([appMessage])
7. _runLoop: isStreaming = true → Ana agent "worker" durumuna geçer

8. agentLoop() başlar:
     stream.push({ type: "message_start", message: appMessage })  // ← CustomMessage event
     stream.push({ type: "message_end", message: appMessage })

9. Bu event'ler AgentSession._handleAgentEvent → _emit() → TUI'ya ulaşır
10. TUI, "subagent-result" renderer ile mesajı görüntüler (display: true)
    → Kullanıcı subagent çıktısını görür

11. LLM'e context gönderilir. CustomMessage → convertToLlm() ile:
      { role: "user", content: "Agent 'explorer' completed its task:\n\n[TAM ÇIKTI]" }
    → LLM, TAM ÇIKTIYI bir "user" mesajı olarak görür

12. LLM response üretir → bazen çıktıyı olduğu gibi echo eder
    → Kullanıcı, LLM'in subagent çıktısını "kendi yazısıymış gibi" yazdığını görür

13. Tüm süre boyunca isStreaming = true → Ana agent "worker" durumunda
```

### Senaryo B: Ana Agent Çalışırken (Streaming)

```
1. Ana agent hâlâ streaming yapıyor (worker state)
2. isStreaming = true

3. Subagent tamamlanır → onAgentTaskDone(handle, output)
4. pi.sendMessage({content: fullOutput, display: true}, {triggerTurn: true, deliverAs: "followUp"})
5. → sendCustomMessage() çalışır:
     - deliverAs === "nextTurn"? → Hayır
     - isStreaming? → Evet
     - deliverAs === "followUp"? → Evet
     ➜ this.agent.followUp(appMessage)  // ← Kuyruğa eklenir

6. appMessage → agent.followUpQueue'ya push edilir
   (Henüz görünür değil — sadece kuyrukta bekliyor)

7. Ana agent'ın mevcut turn'u biter (tool call yok)
8. agentLoop iç döngüden çıkar

9. agentLoop: followUpMessages = getFollowUpMessages() → [appMessage]
10. pendingMessages = followUpMessages → iç döngüye geri döner

11. İç döngüde:
      stream.push({ type: "message_start", message: appMessage })  // ← CustomMessage
      stream.push({ type: "message_end", message: appMessage })

12. TUI render eder (display: true) → Kullanıcı subagent çıktısını görür
13. LLM yeni response üretir → echo edebilir

14. Hâlâ aynı _runLoop içinde → isStreaming = true → "worker" durumu devam ediyor
```

### Senaryo C: Birden Fazla Subagent (En Kötü Durum)

```
1. Ana agent 3 subagent başlatır, turn'unu bitirir
2. Agent A hızlıca tamamlanır → prompt(appMessage_A) → yeni turn başlar
3. Ana agent worker durumuna geçer (isStreaming = true)
4. Agent B tamamlanır → followUp(appMessage_B) → kuyruğa eklenir
5. Agent C tamamlanır → followUp(appMessage_C) → kuyruğa eklenir
6. _runLoop A'yı işler → LLM response üretir
7. agentLoop followUp kontrol → B bulunur → pendingMessages olarak eklenir
8. B işlenir → LLM response üretir
9. agentLoop followUp kontrol → C bulunur → pendingMessages olarak eklenir
10. C işlenir → LLM response üretir
11. agent_end → isStreaming = false

→ Kullanıcı, A → B → C sonuçlarının ardışık olarak conversation'a "aktığını" görür
→ Tüm süre boyunca ana agent "worker" durumunda
→ Her sonuç: CustomMessage render + LLM echo → sanki streaming çıktı sızıyormuş gibi
```

---

## Kök Nedenler (3 Adet)

### Neden 1: `content` Alanında Tam Çıktı

**Dosya:** `agent-manager.ts:454`
```typescript
content: `Agent "${handle.name}" completed its task:\n\n${output}`  // TAM ÇIKTI
```

Bu content, `convertToLlm()` ile `{role: "user", content: [fullOutput]}` olarak LLM'e gönderiliyor.

**Dosya:** `pi-coding-agent/dist/core/messages.js` — `convertToLlm()`:
```typescript
case "custom": {
    const content = typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content;
    return { role: "user", content, timestamp: m.timestamp };
}
```

LLM, binlerce karakterlik agent çıktısını bir "user" mesajı olarak görüyor ve bazen olduğu gibi echo ediyor.

### Neden 2: `display: true` + agentLoop Event Zinciri

CustomMessage, `agentLoop`'un `message_start`/`message_end` event'leri olarak emit ediliyor:

**Dosya:** `pi-agent-core/dist/agent-loop.js:78-82`
```javascript
for (const message of pendingMessages) {
    stream.push({ type: "message_start", message });  // ← TUI bunu yakalar
    stream.push({ type: "message_end", message });     // ← Ve render eder
    currentContext.messages.push(message);
}
```

Bu event'ler AgentSession → TUI'ya ulaşır ve `display: true` olduğu için mesaj conversation'da görünür.

### Neden 3: Tüm Süreç Tek `_runLoop` İçinde

Ana agent'ın `_runLoop`'u şu durumlarda bitmez:
- followUp mesajları kuyruktaysa → iç döngüye geri döner
- isStreaming hep true kalır → ana agent "worker" durumunda görünür
- Birden fazla subagent tamamlanırsa, sonuçlar ardışık işlenir

Bu, kullanıcıya "subagent çıktıları sürekli akıyormuş" izlenimini veriyor.

---

## Neden "Bazen" Oluyor?

| Koşul | Sonuç |
|-------|-------|
| Subagent hızlı tamamlanır + Ana agent boşta | `prompt(appMessage)` → doğrudan işlenir → her zaman görünür |
| Subagent yavaş + Ana agent boşta | Aynı — her zaman görünür |
| LLM kısa çıktı alır | Sentezler, echo etmez → sorun hafif |
| LLM uzun çıktı alır | Echo eder → sorun belirgin |
| 1 subagent | 1 result mesajı → hızlıca geçer |
| 3+ subagent | Ardışık result mesajları → streaming izlenimi yaratır |

---

## Beklenen vs Gerçekleşen Davranış

### Beklenen:
```
[Ana Agent] Agent'lar başlatıldı, bekliyorum...
                                              ← sessizlik, kullanıcı bekler
[Ana Agent] Sonuçlar geldi. İşte analiz:     ← Ana agent sentezlenmiş yanıt yazar
  - Bulgu 1: ...
  - Bulgu 2: ...
```

### Gerçekleşen:
```
[Ana Agent] Agent'lar başlatıldı, bekliyorum...
[CustomMessage] Agent "explorer" completed...  ← display: true → TUI render
[FULL OUTPUT CONTENT]                          ← Binlerce karakter
[Ana Agent - worker] İşte bulgular...          ← LLM echo veya sentez
[CustomMessage] Agent "explorer-2" completed.. ← İkinci agent
[FULL OUTPUT CONTENT 2]                        ← Daha binlerce karakter  
[Ana Agent - worker] Ve ikinci araştırma...    ← LLM response
```

---

## Önerilen Çözümler

### Çözüm 1: `deliverAs: "nextTurn"` Kullan (Hızlı Fix)

```typescript
// agent-manager.ts:onAgentTaskDone()
this.pi.sendMessage(
  {
    customType: "subagent-result",
    content: `Agent "${handle.name}" completed its task:\n\n${output}`,
    display: true,
    details: { ... },
  },
  { triggerTurn: true, deliverAs: "nextTurn" }  // ← "followUp" yerine "nextTurn"
);
```

`nextTurn` şu yolu izler:
```javascript
if (options?.deliverAs === "nextTurn") {
    this._pendingNextTurnMessages.push(appMessage);  // ← Mevcut turn'a müdahale etmez
}
```

Bu, mesajı mevcut turn bitene kadar bekletir. Ancak ana agent idle ise de çalışmaz — sadece kuyrukta bekler.

### Çözüm 2: Content Kısa Tut, Detay details'da (Önerilen)

```typescript
private onAgentTaskDone(handle: AgentHandle, output: string): void {
  const preview = output.split("\n").find(l => l.trim())?.slice(0, 200) || "completed";
  
  this.pi.sendMessage(
    {
      customType: "subagent-result",
      content: `Agent "${handle.name}" completed its task:\n\n${output}`,
      display: true,
      details: {
        agentId: handle.id,
        agentName: handle.name,
        agentColor: handle.color,
        output,
        usage: handle.getUsage(),
        runtimeMode: handle.runtimeMode,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" }
  );
}
```

Not: Burada `content`'i kısaltmak LLM'in tam sonucu görmesini engeller — bu da istenmeyen bir yan etki. LLM'in tam sonucu görmesi gerekiyor ki sentezleyebilsin.

### Çözüm 3: Display False + Ayrı Bildirim (En Temiz)

```typescript
private onAgentTaskDone(handle: AgentHandle, output: string): void {
  // 1. Sessiz context mesajı — LLM görür, TUI göstermez
  this.pi.sendMessage(
    {
      customType: "subagent-result",
      content: `Agent "${handle.name}" completed its task:\n\n${output}`,
      display: false,  // ← TUI'da gösterme
      details: { ... },
    },
    { triggerTurn: true, deliverAs: "followUp" }
  );
  
  // 2. Kısa bildirim — kullanıcı agent'ın bittiğini bilsin (opsiyonel)
  // Bu bir TUI notification olabilir, conversation mesajı değil
  this.managerEvents.emit("agent:completed", handle);
}
```

**Avantaj:** Kullanıcı tam çıktıyı görmez, sadece ana agent'ın sentezlenmiş yanıtını görür.
**Dezavantaj:** Kullanıcı agent'ın ne zaman bittiğini fark etmek için agent panel'e bakmalı.

### Çözüm 4: Hibrit — Display True Ama Renderer Sadece Minimal Gösterir (Zaten Kısmen Var)

Mevcut `subagent-result` renderer ZATEN collapsed modda InlineAgentLine gösteriyor:
```
● explorer · ✓ completed ── output preview · 2 turns  ↑5.1k  $0.02
```

**Sorun:** LLM hâlâ tam `content`'i görüp echo edebilir. Renderer düzgün çalışsa bile, LLM'in yanıtı tam çıktıyı içerebilir.

---

## Sonuç

**Asıl sorun `pi.sendMessage()` → `agentLoop` zincirine dayanıyor:**

1. CustomMessage, agentLoop'un `message_start`/`message_end` event'leri olarak emit ediliyor
2. `display: true` → TUI render eder
3. `content` tam çıktı → LLM user mesajı olarak görüp echo eder
4. Tüm süreç tek `_runLoop` içinde → worker durumu sürekli
5. Birden fazla subagent → ardışık result injection → "streaming sızıntısı" izlenimi

**Bu, subagent-system kodundaki bir bug DEĞİL — pi framework'ünün `sendMessage()` + `agentLoop` tasarımının doğal sonucu. Ancak `content` alanında tam çıktı tutmak ve `display: true` kullanmak, bu davranışı tetikleyen karar.**

İyileştirme için `display: false` + ayrı TUI notification, veya content'i kısa tutup detayı `details`'da tutmak en uygun yaklaşımlar.
