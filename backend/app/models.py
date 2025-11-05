from sqlalchemy import Column, DateTime, Float, Integer, String
from sqlalchemy.sql import func

from .database import Base


class PriceCandle(Base):
    __tablename__ = "price_candles"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime(timezone=True), index=True, nullable=False)
    open = Column(Float, nullable=False)
    high = Column(Float, nullable=False)
    low = Column(Float, nullable=False)
    close = Column(Float, nullable=False)
    volume = Column(Float, nullable=False)
    symbol = Column(String(50), index=True, nullable=False)
    timeframe = Column(String(20), index=True, nullable=False, default="1h")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
