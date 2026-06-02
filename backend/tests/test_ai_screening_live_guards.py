from app.services.ai_screening_service import is_substantive_answer


def test_is_substantive_answer_rejects_empty_and_short_inputs() -> None:
    assert is_substantive_answer("") is False
    assert is_substantive_answer("ok") is False
    assert is_substantive_answer("yes sure") is False
    assert is_substantive_answer("sounds good") is False


def test_is_substantive_answer_accepts_real_answers() -> None:
    assert is_substantive_answer("I led the migration from monolith to services.") is True
    assert is_substantive_answer("In my last project I improved conversion by 18 percent.") is True
