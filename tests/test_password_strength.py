import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FLASK_APP_DIR = PROJECT_ROOT / "flask_app"
if str(FLASK_APP_DIR) not in sys.path:
    sys.path.insert(0, str(FLASK_APP_DIR))

from kasa_core.password_strength import (  # noqa: E402
    ACCEPTABLE_PASSWORD_SCORE,
    analyze_password,
    normalize_user_inputs,
    password_is_weak,
)


class PasswordStrengthTests(unittest.TestCase):
    def test_common_passwords_remain_weak(self) -> None:
        self.assertLess(analyze_password("password")["score"], ACCEPTABLE_PASSWORD_SCORE)
        self.assertLess(analyze_password("P@ssword1")["score"], ACCEPTABLE_PASSWORD_SCORE)

    def test_long_unpredictable_passwords_are_strong(self) -> None:
        self.assertGreaterEqual(
            analyze_password("J7!vQ2#nL9@xR4$k")["score"],
            ACCEPTABLE_PASSWORD_SCORE,
        )
        self.assertFalse(password_is_weak("correct horse battery staple"))

    def test_short_passwords_cannot_score_as_strong(self) -> None:
        analysis = analyze_password("Aa1!short")

        self.assertLess(analysis["score"], ACCEPTABLE_PASSWORD_SCORE)
        self.assertFalse(analysis["requirements"]["min_length"])
        self.assertIn("min_length", analysis["missing_requirements"])

    def test_character_variety_is_required_for_non_passphrases(self) -> None:
        checks = {
            "OnlyLettersLong": ("number", "symbol"),
            "lowercase123!": ("uppercase",),
            "UPPERCASE123!": ("lowercase",),
            "MixedCaseOnlyLong": ("number", "symbol"),
        }

        for password, missing_requirements in checks.items():
            with self.subTest(password=password):
                analysis = analyze_password(password)
                self.assertLess(analysis["score"], ACCEPTABLE_PASSWORD_SCORE)
                for requirement in missing_requirements:
                    self.assertIn(
                        requirement,
                        analysis["missing_requirements"],
                    )

    def test_all_character_requirements_are_reported(self) -> None:
        analysis = analyze_password("J7!vQ2#nL9@xR4$k")

        self.assertTrue(all(analysis["requirements"].values()))
        self.assertEqual(analysis["missing_requirements"], [])

    def test_record_context_penalizes_related_passwords(self) -> None:
        password = "AcmePortal1!"
        without_context = analyze_password(password)["score"]
        with_context = analyze_password(
            password,
            ["AcmePortal", "https://acme.example", "admin@acme.example"],
        )["score"]

        self.assertGreaterEqual(without_context, ACCEPTABLE_PASSWORD_SCORE)
        self.assertLess(with_context, ACCEPTABLE_PASSWORD_SCORE)

    def test_context_normalization_extracts_domain_and_login_tokens(self) -> None:
        values = normalize_user_inputs([
            "https://vault.example.com/login",
            "kaan@example.com",
        ])
        folded_values = {value.casefold() for value in values}

        self.assertIn("vault.example.com", folded_values)
        self.assertIn("vault", folded_values)
        self.assertIn("kaan", folded_values)
        self.assertIn("example.com", folded_values)


if __name__ == "__main__":
    unittest.main()
