# Task Management Extension

Kapsamli gorev yonetim sistemi: CRUD, hiyerarsi, bagimliliklar, sprint'ler ve otomasyon destegi.

## Kurulum

`.pi/extensions/task-management/` dizini `.pi/extensions/` altinda bulunmalidir. Otomatik yuklenir.

## Veri Deposu

Gorevler `.pi/tasks/` dizininde dosya bazli saklanir.

## Komutlar

| Komut | Islem |
|-------|-------|
| `/tasks` | Ana gorev arayuzu |
| `/task-detail <id>` | Tekil gorev detayi |
| `/board` | Kanban gorunum |
| `/sprint` | Sprint yonetimi |
| `/export` | Gorevleri disa aktar (summary/full) |
| `/import` | Markdown'dan iceri aktar |
| `/sync` | TASKS.md ile senkronize et |
| `/task-history` | Degisiklik gecmisini gor |

## Tool Aksiyonlari

### CRUD

| Aksiyon | Aciklama |
|---------|----------|
| `create` | Yeni gorev olustur |
| `get` | Gorev detayini getir |
| `list` | Gorevleri listele |
| `update` | Gorevi guncelle |
| `delete` | Gorevi sil |
| `bulk_create` | Toplu gorev olustur (text parametresiyle) |

### Toplu Islemler

| Aksiyon | Aciklama |
|---------|----------|
| `bulk_delete` | Toplu silme |
| `bulk_set_status` | Toplu durum degistirme |
| `bulk_update` | Toplu guncelleme |
| `bulk_assign_sprint` | Toplu sprint atama |

### Durum Yonetimi

| Aksiyon | Aciklama |
|---------|----------|
| `set_status` | Durum degistir |
| `start` | Gorev uzerinde calismaya basla (in_progress) |
| `complete` | Gorevi tamamla (done) |
| `block` | Gorevi engelle |
| `unblock` | Engeli kaldir |

### Hiyerarsi

| Aksiyon | Aciklama |
|---------|----------|
| `move_under` | Alt goreve tasi |
| `promote` | Ust seviyeye cikar |
| `flatten` | Alt gorevleri duzlestir |
| `tree` | Agac gorunumu |

### Bagimliliklar

| Aksiyon | Aciklama |
|---------|----------|
| `add_dependency` | Bagimlilik ekle |
| `remove_dependency` | Bagimlilik kaldir |
| `check_dependencies` | Bagimliliklari kontrol et |

### Sprint

| Aksiyon | Aciklama |
|---------|----------|
| `create_sprint` | Sprint olustur |
| `start_sprint` | Sprint baslat |
| `complete_sprint` | Sprint tamamla |
| `assign_sprint` | Gorevi sprint'e ata |
| `unassign_sprint` | Sprint'ten cikar |
| `sprint_status` | Sprint durumunu gor |
| `list_sprints` | Sprint'leri listele |

### Diger

| Aksiyon | Aciklama |
|---------|----------|
| `log_time` | Sure kaydet |
| `add_note` | Not ekle |
| `analyze` | Analiz et |
| `prioritize` | Oncelik onerisi al |
| `export` | Disa aktar |
| `import_text` | Markdown'dan iceri aktar |
| `archive` | Tamamlanmislari arsivle |

## Toplu Olusturma (bulk_create)

Text parametresi ile kompakt format (JSON'dan ~5x hizli):

```
Epic gorev [high] #backend
  Alt gorev A [high] @agent ~30m
  Alt gorev B
    Alt-alt gorev
```

| Sozdizimi | Anlam |
|-----------|-------|
| Girinti | Hiyerarsi (ust-alt iliski) |
| `[priority]` | Oncelik (critical/high/medium/low) |
| `#tag` | Etiket |
| `@assignee` | Atanan kisi (user/agent) |
| `~30m` | Tahmini sure |
| `> aciklama` | Gorev aciklamasi |

## Gorev Durumlari

```
todo → in_progress → in_review → done
                   → blocked
                   → deferred
```

## Widget'lar

- **Status widget**: Aktif gorev sayisi, oncelik dagilimi
- **Next tasks widget**: Siradaki yuksek oncelikli gorevler

## Otomasyon

- Bagli gorevler tamamlandiginda otomatik tamamlama
- Context enjeksiyonu (aktif gorev bilgisi agent'a iletilir)
- Event bus uzerinden hook destegi

## Faydalar

- Karmasik projeleri gorevlere bolup takip edebilirsiniz
- Sprint bazli calisma ile zaman yonetimi yapabilirsiniz
- Bagimlilik sistemi ile gorev siralamasini otomatik yonetebilirsiniz
- Kanban gorunumu ile is akisini gorsel olarak takip edebilirsiniz
- Agent ile entegre calisarak gorev takibini otomatiklestirebilirsiniz
- TASKS.md senkronizasyonu ile dokumantasyonu guncel tutabilirsiniz
