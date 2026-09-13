"""Yerel marka ikon kütüphanesi — sıfır ağ isteği (offline-first).

Başlık (title) veya internet adresi (domain) analiz edilerek, uygulamanın
yerel ``static/brand-icons`` klasöründe bulunan marka SVG'lerinden uygun olanı
satır içi (inline) olarak döner. Hiçbir dış URL / Favicon API çağrısı yapılmaz;
tüm ikonlar uygulamanın kendi dosya sisteminden okunur.

Kullanım (Jinja):
    {{ getBrandIcon(kayit.normalized.baslik, kayit.full_data.website_url) | safe }}
"""

from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from markupsafe import Markup

# ── Yerel ikon dizini (__file__ üzerinden çözülür → PyInstaller bundle dahil) ──
_ICON_DIR = Path(__file__).resolve().parent / "static" / "brand-icons"

# Varsayılan jenerik ikon: kasa sifresi kilit ikonu (FontAwesome tasarimi).
# Not: Kilit yayinin (shackle) en üst noktasi viewbox'in 0 satirinin üzerine
# tasar (-32). Üst kismin kesilmemesi icin viewbox dikeyde -40'tan baslatilir
# ve yukseklik 552'ye cikarilir (0-512 icerigi korunur, üstte pay birakilir).
_DEFAULT_CONTENT = (
    '<path d="M80 192v-48a176 176 0 1 1 352 0v48h24c22.3 0 40 17.7 40 40v216'
    "c0 22.3-17.7 40-40 40H56c-22.3 0-40-17.7-40-40V232c0-22.3 17.7-40"
    ' 40-40h24zm32 0h288v-48a144 144 0 1 0-288 0v48z"/>'
)
_DEFAULT_VIEWBOX = "0 -40 512 552"

# ── Kayit tipi ikonlari (marka eslesmezse tip bazinda anlamli ikon) ──────────
# 24x24 stroke tabanli tasarimlar: küçük boyutta (20px kutu) bile net okunur.
# Icerik: küre = dis cember + ekvator + dikey meridyen; masaüstü = monitör.
_TYPE_GLOBE_CONTENT = (
    '<g fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round">'
    '<circle cx="12" cy="12" r="10"/>'
    '<path d="M2 12h20"/>'
    '<path d="M12 2c2.7 2.9 4.6 6.3 4.6 10s-1.9 7.1-4.6 10'
    'c-2.7-2.9-4.6-6.3-4.6-10s1.9-7.1 4.6-10z"/>'
    '</g>'
)
_TYPE_DESKTOP_CONTENT = (
    '<g fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round">'
    '<rect x="2" y="3.5" width="20" height="13" rx="2"/>'
    '<path d="M12 16.5V20"/>'
    '<path d="M8.5 20h7"/>'
    '</g>'
)
_TYPE_CREDITCARD_CONTENT = (
    '<path d="M512 80c0-26.5-21.5-48-48-48H48C21.5 32 0 53.5 0 80v352c0 26.5 21.5'
    "48 48 48h416c26.5 0 48-21.5 48-48V80zM48 64h416c8.8 0 16 7.2 16 16v48H32V80c0"
    "-8.8 7.2-16 16-16zm416 384H48c-8.8 0-16-7.2-16-16V160h448v272c0 8.8-7.2 16-16"
    "16zM64 224c0-17.7 14.3-32 32-32h64c17.7 0 32 14.3 32 32s-14.3 32-32 32H96c-17.7"
    "0-32-14.3-32-32zm0 96c0-17.7 14.3-32 32-32h128c17.7 0 32 14.3 32 32s-14.3 32-32"
    ' 32H96c-17.7 0-32-14.3-32-32z"/>'
)
_TYPE_NOTESTICKY_CONTENT = (
    '<path d="M312 24c0-13.3-10.7-24-24-24s-24 10.7-24 24V48h-48V24c0-13.3-10.7-24'
    "-24-24s-24 10.7-24 24V48H96c-35.3 0-64 28.7-64 64V448c0 35.3 28.7 64 64 64H416"
    "c35.3 0 64-28.7 64-64V112c0-35.3-28.7-64-64-64H312V24zM96 96H416c8.8 0 16 7.2"
    "16 16V448c0 8.8-7.2 16-16 16H96c-8.8 0-16-7.2-16-16V112c0-8.8 7.2-16 16-16z\"/>"
)

# Kayit tipi → (SVG icerik, viewbox). Bilinmeyen/Other tipi burada yoktur;
# onlar icin default kilit ikonu kullanilir (last resort).
_TYPE_ICONS: dict[str, tuple[str, str]] = {
    "Website": (_TYPE_GLOBE_CONTENT, "0 0 24 24"),
    "Application": (_TYPE_DESKTOP_CONTENT, "0 0 24 24"),
    "CreditCard": (_TYPE_CREDITCARD_CONTENT, "0 0 512 512"),
    "SecureNote": (_TYPE_NOTESTICKY_CONTENT, "0 0 512 512"),
}

# Marka → ana alan adları (ikincil alan adları da alt alan eşleşmesiyle çözülür).
BRAND_ROOTS: dict[str, tuple[str, ...]] = {
    "github": ("github.com", "gist.github.com", "githubusercontent.com"),
    "google": (
        "google.com", "google.com.tr", "google.co.uk", "google.de",
        "google.fr", "google.it", "google.es", "google.nl",
        "gmail.com", "googlemail.com", "googlevideo.com",
        "googleapis.com", "googleusercontent.com", "chromium.org",
        "android.com", "blogger.com", "googlecloud.com",
    ),
    "youtube": ("youtube.com", "youtu.be"),
    "instagram": ("instagram.com",),
    "discord": ("discord.com", "discord.gg"),
    "huggingface": ("huggingface.co", "hf.co"),
    "steam": ("steampowered.com", "steamcommunity.com"),
    "x": ("x.com",),
    "twitter": ("twitter.com", "t.co"),
    "linkedin": ("linkedin.com", "lnkd.in"),
    "facebook": ("facebook.com", "fb.com"),
    "reddit": ("reddit.com", "redd.it"),
    "twitch": ("twitch.tv",),
    "telegram": ("telegram.org", "t.me"),
    "whatsapp": ("whatsapp.com", "wa.me"),
    "spotify": ("spotify.com",),
    "netflix": ("netflix.com", "nflxvideo.net"),
    "amazon": (
        "amazon.com", "amazon.com.tr", "amazon.co.uk", "amazon.de",
        "amazon.fr", "amazon.it", "amazon.es", "amazon.in",
        "aws.amazon.com", "amazonaws.com",
    ),
    "apple": ("apple.com", "icloud.com", "itunes.com"),
    "microsoft": (
        "microsoft.com", "live.com", "outlook.com", "hotmail.com",
        "office.com", "office.net", "sharepoint.com", "onedrive.com",
        "bing.com", "xbox.com", "azure.com", "msn.com",
    ),
    "slack": ("slack.com",),
    "figma": ("figma.com",),
    "dropbox": ("dropbox.com",),
    "paypal": ("paypal.com",),
    "gitlab": ("gitlab.com",),
    "zoom": ("zoom.us", "zoom.com"),
    "notion": ("notion.so",),
    "pinterest": ("pinterest.com", "pin.it"),
    "tiktok": ("tiktok.com",),
    "stackoverflow": ("stackoverflow.com", "stackexchange.com"),
}

# Marka → başlık anahtar sözcükleri (küçük harfe indirilmiş başlık token'ları).
BRAND_KEYWORDS: dict[str, tuple[str, ...]] = {
    "github": ("github", "gh"),
    "google": ("google", "gmail", "inbox"),
    "youtube": ("youtube", "tube"),
    "instagram": ("instagram", "insta"),
    "discord": ("discord",),
    "huggingface": ("huggingface", "hugging", "transformers", "hf"),
    "steam": ("steam",),
    "x": ("x",),
    "twitter": ("twitter",),
    "linkedin": ("linkedin",),
    "facebook": ("facebook", "meta", "fb"),
    "reddit": ("reddit",),
    "twitch": ("twitch",),
    "telegram": ("telegram", "tg"),
    "whatsapp": ("whatsapp", "whats"),
    "spotify": ("spotify",),
    "netflix": ("netflix", "nflx"),
    "amazon": ("amazon", "aws"),
    "apple": ("apple", "icloud"),
    "microsoft": ("microsoft", "outlook", "onedrive", "hotmail", "azure",
                   "windows", "office", "bing", "xbox"),
    "slack": ("slack",),
    "figma": ("figma",),
    "dropbox": ("dropbox",),
    "paypal": ("paypal",),
    "gitlab": ("gitlab",),
    "zoom": ("zoom",),
    "notion": ("notion",),
    "pinterest": ("pinterest",),
    "tiktok": ("tiktok", "douyin"),
    "stackoverflow": ("stackoverflow", "stack overflow"),
}

# Marka → orijinal marka rengi (accent/ara yüz entegrasyonu için bilgi).
BRAND_COLORS: dict[str, str] = {
    "github": "#e6edf3",
    "google": "#4285F4",
    "youtube": "#FF0000",
    "instagram": "#E4405F",
    "discord": "#5865F2",
    "huggingface": "#FF9D00",
    "steam": "#66c0f4",
    "x": "#0F1419",
    "twitter": "#1DA1F2",
    "linkedin": "#0A66C2",
    "facebook": "#1877F2",
    "reddit": "#FF4500",
    "twitch": "#9146FF",
    "telegram": "#26A5E4",
    "whatsapp": "#25D366",
    "spotify": "#1DB954",
    "netflix": "#E50914",
    "amazon": "#FF9900",
    "apple": "#A2AAAD",
    "microsoft": "#00A4EF",
    "slack": "#611f69",
    "figma": "#F24E1E",
    "dropbox": "#0061FF",
    "paypal": "#00457C",
    "gitlab": "#FC6D26",
    "zoom": "#2D8CFF",
    "notion": "#FFFFFF",
    "pinterest": "#E60023",
    "tiktok": "#000000",
    "stackoverflow": "#F48024",
}

_KEYWORDS_BY_WORD: dict[str, str] = {}
for _brand, _words in BRAND_KEYWORDS.items():
    for _word in _words:
        _KEYWORDS_BY_WORD.setdefault(_word, _brand)

# Root alan adlarına ~domain~ SUFFIX eşleşmesi için önceden derlenmiş tablo.
_ROOTS_BY_BRAND: dict[str, tuple[str, ...]] = {
    brand: tuple(root.rstrip(".") for root in roots)
    for brand, roots in BRAND_ROOTS.items()
}

# ── İçerik önbelleği & kilidi ────────────────────────────────────────────────
_lookup_lock = threading.Lock()
_icon_cache: dict[str, str] = {}
_available_brands: Optional[frozenset[str]] = None


def _available_brand_keys() -> frozenset[str]:
    """Dosya sistemindeki mevcut ikonları listeler ve önbelleğe alır."""
    global _available_brands
    if _available_brands is None:
        with _lookup_lock:
            if _available_brands is None:
                if _ICON_DIR.is_dir():
                    _available_brands = frozenset(
                        p.stem for p in _ICON_DIR.glob("*.svg")
                    )
                else:
                    _available_brands = frozenset()
    return _available_brands


def _load_svg_content(brand: str) -> Optional[str]:
    """Yerel SVG dosyasını okur (bellek önbellekli)."""
    if brand not in _icon_cache:
        with _lookup_lock:
            if brand not in _icon_cache:
                path = _ICON_DIR / f"{brand}.svg"
                try:
                    content = path.read_text(encoding="utf-8").strip()
                except OSError:
                    content = ""
                if not content:
                    return None
                _icon_cache[brand] = content
    return _icon_cache[brand]


def normalize_domain(raw_domain: str) -> str:
    """URL/adresi parçalayıp küçük, temiz ana alan adına indirir."""
    value = (raw_domain or "").strip().lower()
    if not value:
        return ""
    if "://" not in value:
        value = "//" + value
    try:
        parts = urlsplit(value)
    except ValueError:
        return value
    host = parts.netloc or value
    if "@" in host:
        host = host.rsplit("@", 1)[-1]
    if ":" in host:
        host = host.split(":", 1)[0]
    return host.strip().rstrip(".").lower()


def match_domain_brand(netloc: str) -> Optional[str]:
    """Netloc'u marka kök alan adlarıyla eşleştirir (alt alan dahil)."""
    if not netloc:
        return None
    for brand, roots in _ROOTS_BY_BRAND.items():
        for root in roots:
            if netloc == root or netloc.endswith("." + root):
                if brand in _available_brand_keys():
                    return brand
    return None


def match_title_brand(title: str) -> Optional[str]:
    """Başlık token'larını marka anahtar sözcükleriyle eşleştirir."""
    text = (title or "").lower()
    if not text:
        return None
    tokens = set(re.split(r"[^a-z0-9]+", text))
    tokens.discard("")
    if not tokens:
        return None
    for token in tokens:
        brand = _KEYWORDS_BY_WORD.get(token)
        if brand and brand in _available_brand_keys():
            return brand
    return None


def getBrandIcon(title: str = "", domain: str = "", record_type: str = "") -> Markup:
    """Başlık, internet adresi veya kayıt tipine göre uygun ikonu döner.

    Önce alan adı, ardından başlık analiz edilir. Eşleşme yoksa kayıt tipine
    göre anlamlı bir tip ikonu (Website→dünya, Application→masaüstü,
    CreditCard→kart, SecureNote→not) dönülür. Tip de bilinmiyorsa (boş/Other)
    jenerik kilit ikonuna düşülür (last resort). Sonuç satır içi SVG'dir —
    hiçbir dış URL / Favicon API isteği yapılmaz.

    ``record_type`` opsiyoneldir; verilmezse (2 argümanli çağrilar) davranış
    eski haliyle aynidir (marka yoksa default kilit ikonu).
    """
    brand = match_domain_brand(normalize_domain(domain))
    if brand is None:
        brand = match_title_brand(title)

    if brand is None:
        # Marka eslesmedi → kayit tipine gore tip ikonu; tip de bilinmiyorsa
        # default kilit ikonuna düs (last resort).
        type_icon = _TYPE_ICONS.get(record_type)
        if type_icon is not None:
            content, viewbox = type_icon
            brand = f"type:{record_type}"
        else:
            brand = "default"
            content, viewbox = _DEFAULT_CONTENT, _DEFAULT_VIEWBOX
    else:
        content = _load_svg_content(brand)
        if content is None:
            brand, content, viewbox = "default", _DEFAULT_CONTENT, _DEFAULT_VIEWBOX
        else:
            viewbox = "0 0 24 24"

    svg = (
        f'<svg viewBox="{viewbox}" '
        f'width="1em" height="1em" fill="currentColor" '
        f'aria-hidden="true" focusable="false">{content}</svg>'
    )
    return Markup(
        f'<span class="brand-icon" data-brand="{brand}" aria-hidden="true">{svg}</span>'
    )