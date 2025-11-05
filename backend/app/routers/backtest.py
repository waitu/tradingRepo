from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import BacktestRequest, BacktestResponse
from ..services.backtest_engine import run_backtest

router = APIRouter(prefix="/backtest", tags=["backtest"])


@router.post("/run", response_model=BacktestResponse)
async def run_backtest_endpoint(
    payload: BacktestRequest, db: Session = Depends(get_db)
) -> BacktestResponse:
    try:
        return run_backtest(db, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
