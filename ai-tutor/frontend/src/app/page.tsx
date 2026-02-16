'use client'

import { useState } from 'react'
import HomeScreen from '@/components/HomeScreen'
import ChatScreen from '@/components/ChatScreen'

export interface Subject {
  id: string
  name: string
  icon: string
  color: string
  description: string
}

export interface SessionConfig {
  subject: Subject
  grade: string
}

export default function Home() {
  const [session, setSession] = useState<SessionConfig | null>(null)

  if (session) {
    return (
      <ChatScreen
        subject={session.subject}
        grade={session.grade}
        onBack={() => setSession(null)}
      />
    )
  }

  return <HomeScreen onStart={(config) => setSession(config)} />
}
