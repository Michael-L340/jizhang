import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  name?: string
}
interface State {
  error: Error | null
}

/** 每个页面包一层：某页崩了只影响那一页，其余 tab 照常 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6 text-center">
          <div className="text-lg font-semibold mb-2">{this.props.name ?? '该页面'}出错了</div>
          <div className="text-sm text-muted mb-4 break-all">{this.state.error.message}</div>
          <button className="chip on" onClick={() => this.setState({ error: null })}>
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
