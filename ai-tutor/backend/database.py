"""
数据库模型
"""

from sqlalchemy import create_engine, Column, String, Integer, DateTime, Text, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime

Base = declarative_base()

class Question(Base):
    __tablename__ = "questions"
    
    id = Column(String, primary_key=True)
    subject = Column(String, nullable=False)  # math, english, chinese
    grade = Column(String, nullable=False)
    difficulty = Column(String, nullable=False)  # easy, medium, hard
    content = Column(Text, nullable=False)
    options = Column(Text)  # JSON string
    answer = Column(String)
    explanation = Column(Text)
    knowledge_point = Column(String)
    created_at = Column(DateTime, default=datetime.now)

class PracticeRecord(Base):
    __tablename__ = "practice_records"
    
    id = Column(String, primary_key=True)
    student_id = Column(String, nullable=False)
    question_id = Column(String, ForeignKey("questions.id"))
    is_correct = Column(Integer)
    student_answer = Column(String)
    time_spent = Column(Integer)  # seconds
    created_at = Column(DateTime, default=datetime.now)

class ChatHistory(Base):
    __tablename__ = "chat_history"
    
    id = Column(String, primary_key=True)
    student_id = Column(String, nullable=False)
    subject = Column(String, nullable=False)
    question_id = Column(String, nullable=True)
    messages = Column(Text)  # JSON string
    created_at = Column(DateTime, default=datetime.now)

# SQLite数据库
engine = create_engine("sqlite:///./ai_tutor.db", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def init_db():
    Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
