import csv
import io
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional
def _ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import PriceCandle
from ..schemas import DataImportJob, DatasetListItem, PriceCandleOut

router = APIRouter(prefix="/price-data", tags=["price-data"])

REQUIRED_PRICE_COLUMNS = {"open", "high", "low", "close"}
TIMESTAMP_COLUMN_ALIASES = ("timestamp", "time")


def _parse_timestamp(value: str) -> datetime:
    cleaned = value.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="Timestamp value is missing")

    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"

    try:
        numeric = float(cleaned)
        epoch_seconds = numeric / 1000.0 if numeric > 1e12 else numeric
        return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
    except ValueError:
        pass

    try:
        dt = datetime.fromisoformat(cleaned)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid timestamp format: {value}",
        ) from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _resolve_timestamp_column(header_map: Dict[str, str]) -> str:
    for candidate in TIMESTAMP_COLUMN_ALIASES:
        if candidate in header_map:
            return candidate
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="CSV is missing a timestamp or time column",
    )


def _read_csv_rows(content: bytes) -> Iterable[Dict[str, str]]:
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = content.decode("latin-1")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV is missing a header row")

    header_map = {name.strip().lower(): name for name in reader.fieldnames}
    timestamp_key = _resolve_timestamp_column(header_map)

    missing_prices = REQUIRED_PRICE_COLUMNS - set(header_map.keys())
    if missing_prices:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"CSV is missing required columns: {', '.join(sorted(missing_prices))}",
        )

    volume_column = header_map.get("volume")
    timestamp_column_name = header_map[timestamp_key]

    for raw_row in reader:
        if not raw_row:
            continue

        canonical_row = {
            "timestamp": raw_row.get(timestamp_column_name, "").strip(),
        }
        for column in REQUIRED_PRICE_COLUMNS:
            canonical_row[column] = raw_row.get(header_map[column], "").strip()
        canonical_row["volume"] = raw_row.get(volume_column, "").strip() if volume_column else ""
        yield canonical_row


@router.post("/import", response_model=DataImportJob)
async def import_price_data(
    symbol: str = Form(...),
    timeframe: str = Form(...),
    replaceExisting: bool = Form(True),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> DataImportJob:
    if file.content_type not in {"text/csv", "application/vnd.ms-excel", "application/octet-stream"}:
        raise HTTPException(status_code=415, detail="Only CSV uploads are supported")

    content = await file.read()
    rows = list(_read_csv_rows(content))
    if not rows:
        raise HTTPException(status_code=400, detail="CSV contains no candle rows")

    candles: List[PriceCandle] = []
    for idx, row in enumerate(rows, start=1):
        try:
            timestamp = _parse_timestamp(row["timestamp"])
            open_price = float(row["open"])
            high_price = float(row["high"])
            low_price = float(row["low"])
            close_price = float(row["close"])
            volume_str = row.get("volume", "")
            volume = float(volume_str) if volume_str else 0.0
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid numeric value on row {idx}: {exc}",
            ) from exc
        candles.append(
            PriceCandle(
                timestamp=timestamp,
                open=open_price,
                high=high_price,
                low=low_price,
                close=close_price,
                volume=volume,
                symbol=symbol,
                timeframe=timeframe,
            )
        )

    candles.sort(key=lambda candle: candle.timestamp)

    if replaceExisting:
        db.query(PriceCandle).filter(
            PriceCandle.symbol == symbol,
            PriceCandle.timeframe == timeframe,
        ).delete(synchronize_session=False)

    db.bulk_save_objects(candles)
    db.commit()

    return DataImportJob(symbol=symbol, timeframe=timeframe, recordsImported=len(candles))


@router.get("/datasets", response_model=List[DatasetListItem])
async def list_datasets(db: Session = Depends(get_db)) -> List[DatasetListItem]:
    rows = (
        db.query(
            PriceCandle.symbol,
            PriceCandle.timeframe,
            func.min(PriceCandle.timestamp),
            func.max(PriceCandle.timestamp),
            func.count(PriceCandle.id),
        )
        .group_by(PriceCandle.symbol, PriceCandle.timeframe)
        .all()
    )

    return [
        DatasetListItem(
            symbol=row[0],
            timeframe=row[1],
            earliest=_ensure_utc(row[2]),
            latest=_ensure_utc(row[3]),
            candles=row[4],
        )
        for row in rows
    ]


@router.get("/candles", response_model=List[PriceCandleOut])
async def get_candles(
    symbol: str,
    timeframe: str,
    limit: Optional[int] = None,
    db: Session = Depends(get_db),
) -> List[PriceCandleOut]:
    query = db.query(PriceCandle).filter(
        PriceCandle.symbol == symbol,
        PriceCandle.timeframe == timeframe,
    )

    if limit is not None:
        if limit <= 0 or limit > 5000:
            raise HTTPException(status_code=400, detail="limit must be between 1 and 5000")

        rows = (
            query.order_by(PriceCandle.timestamp.desc())
            .limit(limit)
            .all()
        )
        rows.reverse()
    else:
        rows = query.order_by(PriceCandle.timestamp.asc()).all()

    for candle in rows:
        candle.timestamp = _ensure_utc(candle.timestamp)

    return rows
