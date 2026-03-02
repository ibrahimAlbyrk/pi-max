# 📋 System Prompt Segments — Detaylı Denetim Raporu

**Tarih:** 1 Mart 2026  
**Kapsam:** `dynamic-prompt-system/segments/` altındaki tüm dosyalar  
**Analiz edilen dosyalar:**
1. `core-tone.md` — Ton ve etkileşim protokolü
2. `core-knowledge-base.md` — `.pi/` dizin yapısı konvansiyonları
3. `core-subagent-guidance.md` — Subagent koordinasyon rehberi
4. `core-task-protocol.md` — Task yönetim protokolü
5. `env-git-repo.md` — Git konteksti kuralları

**Toplam Bulgu:** 23  
**Dağılım:** 🔴 Critical × 3 · 🟠 High × 5 · 🟡 Medium × 10 · ⚪ Low × 5

---

## A. HATALAR & TUTARSIZLIKLAR

### A1. Dosya Okuma Kuralı Çelişkisi 🔴 CRITICAL

| Dosya | Kural |
|-------|-------|
| `core-subagent-guidance.md` | *"you may read a single file when you're about to edit it in the same turn"* |
| `core-task-protocol.md` | *"Before starting any task → read its description first (it may contain context you don't have)"* |

**Sorun:** Coordinator, bir task'a başlamadan önce description'ını okumalı diyor task-protocol. Ama subagent-guidance, dosya okumayı SADECE "edit yapacaksan" izin veriyor. Task description okumak edit değil → protokol kendisiyle çelişiyor.

**Etki:** Coordinator task description'ını okuyamaz hale gelir veya kuralı ihlal eder.

---

### A2. Soru–Aksiyon Çelişkisi 🔴 CRITICAL

| Dosya | Kural |
|-------|-------|
| `core-tone.md` | *"Question → Answer + STOP. Do NOT take action, spawn agents, or run tools unless explicitly asked."* |
| `core-subagent-guidance.md` | *"ALL research → spawn explorer"* |

**Sorun:** Kullanıcı "bu projede kaç dosya var?" diye sorarsa → core-tone "STOP, cevap ver" diyor, ama subagent-guidance "explorer spawn et" diyor. Bir soru aynı anda hem research hem question olabilir. Hangisi geçerli?

**Etki:** LLM her soru/research kesişiminde farklı davranabilir — tutarsız UX.

---

### A3. Confirmation Protokolü Çelişkisi 🟠 HIGH

| Dosya | Kural |
|-------|-------|
| `env-git-repo.md` | *"Always confirm before force push or destructive operations"* |
| `core-tone.md` | *"Explicit request → Act. Only execute when user clearly asks you to do/build/fix/change/create something."* |

**Sorun:** Kullanıcı açıkça "force push yap" derse → core-tone'a göre bu yeterli onay. Ama env-git-repo ek confirmation istiyor. Hangisi geçerli?

**Etki:** Ya gereksiz confirmation döngüsü, ya da tehlikeli operasyonda onay atlanması.

---

### A4. "Multi-Step" Tanımsız 🟠 HIGH
**Dosya:** `core-task-protocol.md`

> *"Multi-step work → plan first, then create tasks before any code. Single action → do directly, skip tasks."*

**Sorun:** 2 adım multi-step mi? 50 satır kod yazmak single action mı? Eşik değer yok. LLM, karmaşık işleri "single action" olarak sınıflandırıp task oluşturmayı atlayabilir.

---

### A5. "Destructive Operations" Tanımsız 🟡 MEDIUM
**Dosya:** `env-git-repo.md`

> *"Always confirm before force push or destructive operations"*

**Sorun:** `git reset --hard`, `git rebase`, `git clean -fd`, `git checkout -- .` destructive mi? Tanım yok. LLM'nin yorumuna bırakılmış.

---

## B. PERFORMANS KAYBI (Token İsrafı)

### B1. Aynı Kural 3 Kez Tekrarlanıyor 🟠 HIGH
**Dosya:** `core-subagent-guidance.md`

Aynı "dosya okuma" kuralı üç ayrı yerde:

1. **Giriş paragrafı:** *"Only exception: you may read a single file when you're about to edit it in the same turn."*
2. **Tool routing:** *"read/grep/ls/find → ONLY for a single file you are about to EDIT in the same turn"*
3. **İma olarak:** *"Research (search, discover, analyze, understand, compare, list, multi-file reads) → explorer"*

**Token maliyeti:** ~30 token fazlalık. Tek bir yerde net söylemek yeterli.

---

### B2. Subagent "When" Örnekleri Gereksiz Uzun 🟡 MEDIUM
**Dosya:** `core-subagent-guidance.md`

```
- **explorer** — ALL research: search, read, list, analyze, discover, understand code
  - When: you need to understand codebase, find files, read multiple files, compare implementations
- **planner** — architecture decisions & implementation design
  - When: new feature architecture, large refactor strategy, tech stack decisions, breaking down complex specs
```

**Sorun:** Agent adı + tek satır açıklama yeterli. "When" satırları zaten açıklamayı tekrarlıyor. 4 agent × 2 satır = ~60 token fazlalık.

---

### B3. Interaction Protocol İç Tekrarı 🟡 MEDIUM
**Dosya:** `core-tone.md`

```
- Question → Answer + STOP. Do NOT take action, spawn agents, or run tools unless explicitly asked.
- Explicit request → Act. Only execute when user clearly asks you to do/build/fix/change/create something.
```

**Sorun:** Bu iki madde birbirinin tersi — biri diğerini ima ediyor. Tek madde yeterli:
> *"Act ONLY on explicit requests. Questions → answer + stop."*

---

### B4. Error Handling Yanlış Dosyada 🟡 MEDIUM
**Dosya:** `env-git-repo.md`

> *"Tool error → retry once. If still fails → inform user with error detail."*

**Sorun:** Bu kural git'e özgü değil, genel bir kural. Ya core-tone'da olmalı ya da hiç olmamalı (zaten orada var mı kontrol → evet, core-tone'da da benzer bir error handling var: *"Never silently ignore errors"*). İki dosyada error handling = tekrar.

---

## C. HALÜSINASYON RİSKİ

### C1. "Codeable Detail Level" Tanımsız 🟠 HIGH
**Dosya:** `core-knowledge-base.md`

> *specs/ | Implementation specs... Codeable detail level.*

**Sorun:** LLM "codeable detail" seviyesini kendisi yorumlayacak. Kimisi pseudo-code yazar, kimisi sadece bullet points. Bir örnek veya minimum gereksinim listesi (ör. "input/output tipleri, edge case'ler, error handling tanımlanmalı") olmalı.

---

### C2. "Concise Responses" Ölçüsüz 🟠 HIGH
**Dosya:** `core-tone.md`

> *Concise responses*

**Sorun:** "Concise" ne kadar? Code review'da 3 satır mı? Mimari kararda 1 paragraf mı? LLM bunu farklı context'lerde farklı yorumlar → tutarsız output uzunluğu.

---

### C3. "Self-Contained" Task Description Muğlak 🟡 MEDIUM
**Dosya:** `core-task-protocol.md`

> *"Description MUST be self-contained: what to do, why, acceptance criteria, and file/doc references"*

**Sorun:** "Self-contained" ne kadar detay? Dosya pathlerini mi, fonksiyon isimlerini mi, satır numaralarını mı içermeli? LLM bazen çok az, bazen çok fazla yazar.

---

### C4. Git "Confirm" Mekanizması Belirsiz 🟡 MEDIUM
**Dosya:** `env-git-repo.md`

> *"Always confirm before force push or destructive operations"*

**Sorun:** Nasıl confirm edilecek? Kullanıcıya soru mu sorulacak? Hangi formatta? LLM bazen sadece "yapayım mı?" der, bazen detaylı risk analizi yapar — standart yok.

---

## D. ODAK KAYBI

### D1. Subagent Dosyası Bilgi Yoğunluğu 🟡 MEDIUM
**Dosya:** `core-subagent-guidance.md`

**Sorun:** Tek dosyada: role tanımı, 4 agent açıklaması, tool routing, delegation rules, spawning protocol. Coordinator her seferinde tüm bunları parse etmek zorunda. Sadece ilgili agent/rule'ün aktif olması daha performanslı olurdu.

---

### D2. Quality Section Yanlış Bağlam 🟡 MEDIUM
**Dosya:** `core-task-protocol.md`

```
## Quality
✓ "JWT middleware with refresh token rotation"
✗ "Build the backend"
```

**Sorun:** Bu section protocol kuralları arasında kaybolmuş. "Task yazım kalitesi" ile "task protocol'ü" farklı konseptler. İlgili ama organizasyonel olarak yanıltıcı.

---

### D3. Git Segment'i Environment vs Core Karışımı ⚪ LOW
**Dosya:** `env-git-repo.md`

**Sorun:** Hem environment-specific kurallar (*"Use conventional commits"*) hem genel kurallar (*"Tool error → retry once"*) aynı dosyada. Scope bulanık.

---

## E. GEREKSIZ KISIMLAR

### E1. "Immutable" Etiketi Enforced Değil 🟡 MEDIUM
**Dosya:** `core-knowledge-base.md`

> *reports/ | ... | **Immutable** after creation*

**Sorun:** Teknik bir enforcing mekanizması yok. LLM report dosyasını düzenleyebilir. "Immutable" etiketi yanlış güven veriyor.

---

### E2. Ambiguous Satır Tekrarı ⚪ LOW
**Dosya:** `core-tone.md`

> *"Ambiguous → Clarify. When unsure if user wants information or action, ASK before acting."*

**Sorun:** İlk iki madde zaten question/action ayrımını net yapıyor. Üçüncü madde edge case için var ama ilk ikisinden çıkarılabilir.

---

### E3. "Never Chain" Kuralı Redundant ⚪ LOW
**Dosya:** `core-tone.md`

> *"Never chain: answer → action. These are separate interaction types."*

**Sorun:** İlk iki maddede zaten söyleniyor. Bu üçüncü tekrar.

---

## F. TEKRAR / FAZLALIK (Cross-File)

### F1. "STOP" Kuralı İki Dosyada 🟡 MEDIUM

| Dosya | Metin |
|-------|-------|
| `core-tone.md` | *"Question → Answer + STOP"* |
| `core-subagent-guidance.md` | *"After spawning → STOP. Do NOT continue working."* |

Aynı "dur" konsepti iki ayrı dosyada, farklı context'lerde. Konsolide edilebilir.

---

### F2. Error Handling İki Dosyada 🟡 MEDIUM

| Dosya | Metin |
|-------|-------|
| `core-tone.md` | *"Tool error → retry once. If still fails → inform user"* |
| `env-git-repo.md` | *"Tool error → retry once..."* (aynı veya benzer kural) |

---

### F3. "One Task at a Time" & "After Spawning STOP" Örtüşme ⚪ LOW

| Dosya | Metin |
|-------|-------|
| `core-task-protocol.md` | *"One active task at a time"* |
| `core-subagent-guidance.md` | *"After spawning → STOP. Do NOT continue working."* |

Farklı bağlamda ama aynı prensip: aynı anda tek iş yap.

---

### F4. Tool Routing Aynı Dosyada 3× 🟠 HIGH
**Dosya:** `core-subagent-guidance.md`

(B1 ile aynı — yukarıda detaylandırıldı)

---

## ÖZET TABLO

| # | Bulgu | Kategori | Şiddet | Dosya |
|---|-------|----------|--------|-------|
| A1 | Dosya okuma kuralı çelişkisi | Hata | 🔴 Critical | subagent ↔ task |
| A2 | Soru–aksiyon çelişkisi | Hata | 🔴 Critical | tone ↔ subagent |
| A3 | Confirmation çelişkisi | Hata | 🟠 High | git ↔ tone |
| A4 | "Multi-step" tanımsız | Hata | 🟠 High | task-protocol |
| A5 | "Destructive ops" tanımsız | Hata | 🟡 Medium | git |
| B1 | Aynı kural 3× tekrar | Performans | 🟠 High | subagent |
| B2 | "When" örnekleri gereksiz | Performans | 🟡 Medium | subagent |
| B3 | Interaction protocol iç tekrar | Performans | 🟡 Medium | tone |
| B4 | Error handling yanlış dosyada | Performans | 🟡 Medium | git |
| C1 | "Codeable detail" tanımsız | Halüsinasyon | 🟠 High | knowledge-base |
| C2 | "Concise" ölçüsüz | Halüsinasyon | 🟠 High | tone |
| C3 | "Self-contained" muğlak | Halüsinasyon | 🟡 Medium | task-protocol |
| C4 | "Confirm" mekanizması belirsiz | Halüsinasyon | 🟡 Medium | git |
| D1 | Subagent bilgi yoğunluğu | Odak Kaybı | 🟡 Medium | subagent |
| D2 | Quality section yanlış bağlam | Odak Kaybı | 🟡 Medium | task-protocol |
| D3 | Git scope karışımı | Odak Kaybı | ⚪ Low | git |
| E1 | "Immutable" enforced değil | Gereksiz | 🟡 Medium | knowledge-base |
| E2 | Ambiguous satır tekrarı | Gereksiz | ⚪ Low | tone |
| E3 | "Never chain" redundant | Gereksiz | ⚪ Low | tone |
| F1 | "STOP" iki dosyada | Tekrar | 🟡 Medium | tone ↔ subagent |
| F2 | Error handling iki dosyada | Tekrar | 🟡 Medium | tone ↔ git |
| F3 | "One task" örtüşme | Tekrar | ⚪ Low | task ↔ subagent |
| F4 | Tool routing 3× aynı dosya | Tekrar | 🟠 High | subagent |

---

## ACİL AKSİYON ÖNERİLERİ

### 🔴 Hemen Düzeltilmeli (Critical)

1. **A1 — Dosya okuma kuralını netleştir:** Coordinator'ın task description + kendi context dosyalarını okumasına izin ver. "Edit öncesi tek dosya" kuralını "edit veya task context için" olarak genişlet.

2. **A2 — Soru vs research ayrımını tanımla:** "Cevaplamak için araştırma gerekiyorsa → explorer spawn et" gibi net bir escape hatch ekle. Veya: "Bilginle cevaplayabiliyorsan → direkt cevapla. Bilmiyorsan → explorer."

### 🟠 Bu Sprint Düzeltilmeli (High)

3. **A3 — Confirmation kuralını birleştir:** Tek bir yerde, net: "Destructive git ops (force push, reset --hard, clean -fd) → her zaman ek confirmation, kullanıcı açıkça istese bile."

4. **A4 — Multi-step tanımı:** "2+ bağımsız adım veya 2+ dosya değişikliği → task oluştur."

5. **B1/F4 — Tool routing konsolidasyonu:** `core-subagent-guidance.md`'de dosya okuma kuralını TEK YERDE söyle.

6. **C1 — "Codeable detail" tanımı ekle:** "Input/output types, edge cases, error scenarios, ve state transitions içermeli."

7. **C2 — "Concise" tanımı ekle:** "Explanation ≤ 3 cümle, code comments inline, error messages 1 satır."

### 🟡 Orta Vadede İyileştir (Medium)

8. Cross-file tekrarları (F1, F2) konsolide et — error handling ve STOP kuralı tek yerde.
9. Subagent dosyasını compact hale getir — "When" satırlarını kaldır.
10. "Immutable" etiketini "Convention: do not edit after creation" olarak yeniden ifade et.
