"""SQLAlchemy models used by the local vault."""

from datetime import datetime

from flask_login import UserMixin

from kasa_core.constants import DEFAULT_CATEGORY
from kasa_core.extensions import db


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
    encrypted_password = db.Column(db.String, default="")
    encrypted_comment = db.Column(db.String, default="")
    is_pinned = db.Column(db.Integer, default=0)
    expiry_date = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
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
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class User(UserMixin):
    def __init__(self, id: str):
        self.id = id
