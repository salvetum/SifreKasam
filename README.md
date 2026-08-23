# ŞifreKasam v3 🦀

> **Durum:** Planlama / Erken Öğrenme Aşaması
> 
> **Yapay Zeka Politikası:** Bu projede hiçbir satır yapay zeka tarafından yazılmayacaktır.

---

## 🇹🇷 Türkçe

### Bu proje ne?

ŞifreKasam v3, önceki sürümlerin (Python/Flask + Electron ile yazılmış) tamamen
**sıfırdan, Rust ile yeniden yazılmış** hâlidir. Bu bir "port" değil, gerçek
bir **yeniden yazım**dır — v1/v2'den hiçbir kod satırı taşınmayacak.

### Amaç

Bu projenin **birincil hedefi Rust öğrenmek ve dilde ustalaşmaktır.**
Uygulamayı "daha iyi" hale getirmek ikincil bir hedeftir — yani bazı
kararlar, "en hızlı/en pratik" yol yerine "en çok öğrendiren" yol
gözetilerek verilebilir.

### Temel kural: Yapay zeka desteği yok

v3'ün geliştirme sürecinde kod üretimi için **hiçbir yapay zeka aracı
kullanılmayacaktır** (kod tamamlama önerileri, sohbet tabanlı kod üretimi,
otomatik refactor araçları dahil). Amaç, her satırı gerçekten anlayarak
yazmak ve derleyici hatalarıyla, ödünç alma denetleyicisiyle (borrow
checker) ve tip sistemiyle **kendi başına** boğuşmaktır.

IDE'nin hata gösterme, syntax highlighting, debugging gibi standart
özellikleri elbette kullanılabilir — kısıtlama yalnızca *kod üretimi*
içindir.

### Yaklaşım: Önce backend, sonra arayüz

Geliştirme sırası bilinçli olarak şöyle planlanmıştır:

1. **Rust temelleri** — ownership, borrowing, lifetime'lar, trait sistemi
   (SifreKasam'dan bağımsız küçük alıştırmalarla)
2. **Çekirdek mantık (backend, GUI'siz)** — şifreleme, kayıt yönetimi,
   veri depolama; muhtemelen bir CLI (komut satırı) arayüzü üzerinden
   test edilecek
3. **Basit bir GUI iskeleti** — pencere açma, form, temel etkileşim
4. **Özel görsel katman** — GPU tabanlı, native "liquid glass" tasarımı
   (en son aşama; en çok mühendislik gerektiren kısım)

Bu sıralamanın nedeni: GUI ve GPU programlamasına erken atlamak, Rust'ın
kendi öğrenme eğrisiyle (ownership/borrowing) render/shader
karmaşıklığını aynı anda üstlenip motivasyon kaybına yol açabilir.

### Hedeflenen özellikler (yol gösterici, kesin değil)

- Ana şifre ile korunan, yerel (offline-first) bir şifre kasası
- Güçlü, modern şifreleme (RustCrypto ekosistemindeki olgun crate'ler
  üzerinden)
- GPU tabanlı, gerçek zamanlı "liquid glass" (buzlu/kırılmalı cam) görsel
  efekti — CSS taklidi değil, gerçek shader tabanlı render
- Windows ve Linux desteği

### Neler v2'den devralınmayacak

- Python/Flask backend
- Electron
- Mevcut HTML/CSS/JS arayüz kodu
- Yapay zeka aracıyla (opencode ile) yazılmış hiçbir satır

### Katkı ve lisans

Bu proje şu an itibarıyla kişisel bir öğrenme projesidir.

---

## 🇬🇧 English

### What is this?

ŞifreKasam v3 is a **complete rewrite from scratch, in Rust**, of the
previous versions (which were written in Python/Flask + Electron). This
is not a port — no code from v1/v2 will be carried over.

### Purpose

The **primary goal of this project is to learn Rust and become
proficient in it.** Making the application "better" is a secondary goal
— some decisions may favor the path that teaches the most, rather than
the fastest or most practical one.

### Core rule: No AI assistance

**No AI tools will be used for code generation** during v3's
development (this includes AI code completion suggestions, chat-based
code generation, and automated refactoring tools). The goal is to write
every line with genuine understanding, and to work through compiler
errors, the borrow checker, and the type system **independently**.

Standard IDE features — error highlighting, syntax highlighting,
debugging — are of course fine to use. The restriction applies only to
*code generation*.

### Approach: Backend first, interface later

The development order is deliberately planned as follows:

1. **Rust fundamentals** — ownership, borrowing, lifetimes, the trait
   system (via small exercises independent of SifreKasam)
2. **Core logic (backend, no GUI)** — encryption, record management,
   data storage; likely tested through a CLI (command-line) interface
   first
3. **A simple GUI skeleton** — opening a window, forms, basic
   interaction
4. **The custom visual layer** — a GPU-based, native "liquid glass"
   design (the final stage; the part requiring the most engineering)

The reasoning behind this order: jumping into GUI and GPU programming
too early risks tackling Rust's own learning curve (ownership/borrowing)
at the same time as rendering/shader complexity, which can lead to
losing motivation.

### Intended features (a guide, not a fixed spec)

- A local, offline-first password vault protected by a master password
- Strong, modern encryption (via mature crates in the RustCrypto
  ecosystem)
- A GPU-based, real-time "liquid glass" visual effect — not a CSS
  imitation, but genuine shader-based rendering
- Windows and Linux support

### What will NOT carry over from v2

- The Python/Flask backend
- Electron
- The existing HTML/CSS/JS interface code
- Any line written with the help of an AI tool (opencode)

### Contributing & license

This project is currently a personal learning project.

---

*Bu README, projenin ilk aşamasında hazırlanmıştır ve geliştirme
ilerledikçe güncellenmesi beklenir.*
*This README was prepared at the project's earliest stage and is
expected to evolve as development progresses.*
