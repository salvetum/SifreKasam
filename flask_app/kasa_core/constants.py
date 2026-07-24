"""Application constants shared by backend modules."""

APP_VERSION_DEFAULT = "2.5.9-beta.2"
UPDATE_REPOSITORY = "salvetum/SifreKasam"
UPDATE_RELEASE_API = f"https://api.github.com/repos/{UPDATE_REPOSITORY}/releases/latest"

SECRET_PLACEHOLDER = "__SECRET__"
MAX_BULK_IDS = 500
MAX_IMPORT_RECORDS = 5000
VALID_RECORD_TYPES = {"Website", "Application", "CreditCard", "SecureNote", "Other"}
DEFAULT_CATEGORY = "Genel"

DEFAULT_ACCENT_COLOR = "#7c6ff7"
DEFAULT_BACKGROUND_STYLE = "aurora"
VALID_BACKGROUND_STYLES = {"aurora", "midnight", "mesh", "plain"}
DEFAULT_GLASS_QUALITY = "normal"
VALID_GLASS_QUALITIES = {"low", "normal", "high"}
DEFAULT_ANIMATED_BACKGROUNDS_ENABLED = True
DEFAULT_INTERFACE_ANIMATIONS_ENABLED = True
DEFAULT_GRADIENTS_ENABLED = True

LEGACY_PBKDF2_SALT = b"kasa_masaustu_salt_12345"
PBKDF2_SALT_SETTING = "pbkdf2_salt_b64"
PBKDF2_ITERATIONS = 600_000
LEGACY_PBKDF2_ITERATIONS = 100_000
RECORD_METADATA_PREFIX = "sifrekasam:v1:"
RECORD_METADATA_SETTING = "record_metadata_encryption_v1"
RECORD_METADATA_FIELDS = ("title", "website_url", "login")
