"""M-Pesa statement CSV ingestion.

Safaricom statement exports carry preamble rows before the real header, so the
parser hunts for the header row (the one containing "Receipt No") instead of
assuming line 1. Amounts: "Paid In" → direction in, "Withdrawn" → out.
"""
import csv
import io


def _amount(text):
    text = (text or "").replace(",", "").strip()
    if text in ("", "-"):
        return 0.0
    return abs(float(text))


def parse_mpesa_statement(csv_text):
    rows = list(csv.reader(io.StringIO(csv_text)))
    header_idx = None
    for i, row in enumerate(rows):
        joined = " ".join(cell.strip().lower() for cell in row)
        if "receipt" in joined and "details" in joined:
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("statement header row not found")
    header = [c.strip().lower() for c in rows[header_idx]]

    def col(*names):
        for name in names:
            if name in header:
                return header.index(name)
        return None

    c_receipt = col("receipt no", "receipt no.", "receipt")
    c_time = col("completion time", "date", "transaction date")
    c_details = col("details", "transaction details")
    c_in = col("paid in", "paid in (kes)", "credit")
    c_out = col("withdrawn", "withdrawn (kes)", "paid out", "paid out (kes)", "debit")
    c_balance = col("balance", "balance (kes)")

    txns = []
    for row in rows[header_idx + 1:]:
        if not row or all(not c.strip() for c in row):
            continue
        if c_in is None and c_out is None:
            continue
        paid_in = _amount(row[c_in]) if c_in is not None and c_in < len(row) else 0.0
        withdrawn = _amount(row[c_out]) if c_out is not None and c_out < len(row) else 0.0
        if paid_in == 0.0 and withdrawn == 0.0:
            continue
        direction = "in" if paid_in > 0 else "out"
        txns.append({
            "date": (row[c_time].strip() if c_time is not None and c_time < len(row) else ""),
            "details": (row[c_details].strip() if c_details is not None and c_details < len(row) else ""),
            "receipt": (row[c_receipt].strip() if c_receipt is not None and c_receipt < len(row) else ""),
            "amount_kes": paid_in if direction == "in" else withdrawn,
            "direction": direction,
            "balance_kes": (_amount(row[c_balance])
                            if c_balance is not None and c_balance < len(row) else None),
            "source": "mpesa_statement",
            "stream": None,
            "category": None,
            "confidence": 1.0,
        })
    return txns
