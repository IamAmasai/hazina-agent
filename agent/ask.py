"""The ask loop. Hazi asks only about what the evidence cannot show, one
specific question per unexplained item, quoting the actual statement line.
Answers are written back as human-stamped records and classify the
transaction. Bounded: after the asking round, anything still unanswered is
escalated into the pack as an explicit flag — never guessed, never dropped.
"""
MAX_ROUNDS = 3  # workshop pattern: bounded tries, then escalate with the list


def generate_questions(record, transaction_ids):
    """One question per unexplained statement line. Skips lines that already
    have an open or answered question."""
    asked = {q["transaction_id"] for q in record.data["questions"]}
    made = []
    by_id = {t["id"]: t for t in record.transactions()}
    for txn_id in transaction_ids:
        if txn_id in asked:
            continue
        txn = by_id.get(txn_id)
        if not txn:
            continue
        q = record.add_question(
            txn_id,
            f"KSh {txn['amount_kes']:,.0f} out on {txn['date'][:10]} — "
            f"\"{txn['details']}\". Was this a business cost? If yes, what "
            f"kind (supplies, wages, rent, transport, other)? If it was "
            f"personal, say personal.")
        made.append(q)
    if made:
        record.data["status"] = "needs_input"
    return made


def apply_answer(record, question_id, answer, category=None, business=True):
    """The merchant's answer is a record: it classifies the transaction."""
    q = record.answer_question(question_id, answer, actor="human")
    for txn in record.transactions():
        if txn["id"] == q["transaction_id"]:
            txn["category"] = category
            txn["business"] = business
            txn["classified_by"] = "merchant_answer"
    return q


def escalate_unanswered(record):
    """Bounded refusal: unanswered questions become pack flags, listed with
    the problem, after MAX_ROUNDS of asking."""
    open_qs = [q for q in record.data["questions"] if q["status"] == "open"]
    for q in open_qs:
        q["status"] = "escalated"
    if open_qs:
        record.log("system", "questions_escalated",
                   f"{len(open_qs)} unanswered after {MAX_ROUNDS} rounds: "
                   + ", ".join(q["id"] for q in open_qs))
    return open_qs


def finalise_gate(record):
    """The pack may finalise when every question is answered or explicitly
    escalated. Open questions block finalisation."""
    open_qs = [q for q in record.data["questions"] if q["status"] == "open"]
    escalated = [q for q in record.data["questions"] if q["status"] == "escalated"]
    return {"ok": not open_qs,
            "open": [q["id"] for q in open_qs],
            "escalated": [q["id"] for q in escalated]}
