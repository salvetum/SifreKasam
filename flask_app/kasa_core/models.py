"""SQLAlchemy models used by the local vault."""

from flask_login import UserMixin

from kasa_core.constants import DEFAULT_CATEGORY
from kasa_core.extensions import db
from kasa_core.time_utils import utc_now_naive


class Setting(db.Model):
    __tablename__ = "settings"

    key = db.Column(db.String, primary_key=True)
    value = db.Column(db.String)


class Record(db.Model):
    __tablename__ = "records"

    id = db.Column(db.String, primary_key=True)
    type = db.Column(db.String, nullable=False)
    category = db.Column(db.String, default=DEFAULT_CATEGORY)
    title = db.Column(db.String, nullable=False)
    website_url = db.Column(db.String, default="")
    login = db.Column(db.String, default="")
    email = db.Column(db.String, default="")
    encrypted_password = db.Column(db.String, default="")
    encrypted_comment = db.Column(db.String, default="")
    is_pinned = db.Column(db.Integer, default=0)
    expiry_date = db.Column(db.DateTime, nullable=True)
    card_holder = db.Column(db.String, default="")
    # Kart markası ("visa", "garanti" …) — `static/brand-icons` içindeki
    # dosya adıyla birebir aynı olmalıdır, `brand_icons.normalize_card_brand`
    # beyaz listeyle doğrular. 🔴 Düz metin, şifreli DEĞİL: marka sır değil,
    # `category`/`type` ile aynı sınıf (metadata) ve ızgarada zaten görünür.
    # Şifrelemek yalnız yazma maliyeti getirirdi.
    card_brand = db.Column(db.String, default="")
    # Özel alanlar ve etiketler: şifreli TEK JSON kümesi (ayrı tablo yok).
    # Gerekçe ve güvenlik sınıflandırması `kasa_core/record_extras.py` başında.
    encrypted_custom_fields = db.Column(db.Text, default="")
    encrypted_tags = db.Column(db.Text, default="")
    # Kayda eklenen dosya. Gövde Fernet metni olarak **bayt** saklanır (base64
    # metnin bayta çevrilmiş hâli; ölçülebilir gerekçe `attachments.py`).
    # 🔴 `encrypted_attachment` NULL ise kayıtta ek yoktur; `LargeBinary`
    # nullable=False yapılsaydı her kayıt boş bayt taşırdı.
    encrypted_attachment = db.Column(db.LargeBinary, nullable=True)
    # Dosya adı da şifrelenir: "kaskad_police_tamir.pdf" adı bile sızdırır.
    attachment_name = db.Column(db.String, default="")
    attachment_mime = db.Column(db.String, default="")
    attachment_size = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, default=utc_now_naive)
    updated_at = db.Column(
        db.DateTime,
        default=utc_now_naive,
        onupdate=utc_now_naive,
    )


class PasswordHistory(db.Model):
    __tablename__ = "password_history"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    record_id = db.Column(
        db.String,
        db.ForeignKey("records.id", ondelete="CASCADE"),
        nullable=False,
    )
    encrypted_password = db.Column(db.String, nullable=False)
    created_at = db.Column(db.DateTime, default=utc_now_naive)


class User(UserMixin):
    def __init__(self, id: str):
        self.id = id
