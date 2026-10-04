export interface PrefEvalExplicitInstance {
  preference: string
  question: string
  explanation?: string
}

export interface PrefEvalChoiceConversation {
  query: string
  assistant_options: string
  user_selection: string
  assistant_acknowledgment: string
}

export interface PrefEvalChoiceInstance {
  preference: string
  question: string
  explanation?: string
  conversation: PrefEvalChoiceConversation
}

export interface PrefEvalPersonaTurn {
  user: string
  assistant: string
}

export interface PrefEvalPersonaInstance {
  preference: string
  question: string
  explanation?: string
  persona?: string
  conversation: Record<string, PrefEvalPersonaTurn>
}

export interface PrefEvalDistractorTurn {
  content: string
  role: string
}

export interface PrefEvalDistractorConversation {
  conversation_id: string
  conversation: PrefEvalDistractorTurn[]
}
