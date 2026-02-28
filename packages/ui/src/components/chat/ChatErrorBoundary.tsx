import React from 'react';
import { RiChat3Line, RiRestartLine } from '@remixicon/react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useLanguage } from '@/hooks/useLanguage';

interface ChatErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
}

interface ChatErrorBoundaryProps {
  children: React.ReactNode;
  sessionId?: string;
}

interface InternalChatErrorBoundaryProps extends ChatErrorBoundaryProps {
  t: (key: string) => string;
}

class InternalChatErrorBoundary extends React.Component<InternalChatErrorBoundaryProps, ChatErrorBoundaryState> {
  constructor(props: InternalChatErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ChatErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo });

    if (process.env.NODE_ENV === 'development') {
      console.error('Chat error caught by boundary:', error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-4">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <CardTitle className="flex items-center justify-center gap-2 text-destructive">
                <RiChat3Line className="h-5 w-5" />
                {this.props.t('chatErrorBoundary.chatError')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {this.props.t('chatErrorBoundary.description')}
              </p>

              {this.props.sessionId && (
                <div className="text-xs text-muted-foreground text-center">
                  {this.props.t('chatErrorBoundary.session')}: {this.props.sessionId}
                </div>
              )}

              {this.state.error && (
                <details className="text-xs font-mono bg-muted p-3 rounded">
                  <summary className="cursor-pointer hover:bg-interactive-hover/80">{this.props.t('chatErrorBoundary.errorDetails')}</summary>
                  <pre className="mt-2 overflow-x-auto">
                    {this.state.error.toString()}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={this.handleReset} variant="outline" className="flex-1">
                  <RiRestartLine className="h-4 w-4 mr-2" />
                  {this.props.t('chatErrorBoundary.resetChat')}
                </Button>
              </div>

              <div className="text-xs text-muted-foreground text-center">
                {this.props.t('chatErrorBoundary.refreshHint')}
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export const ChatErrorBoundary: React.FC<ChatErrorBoundaryProps> = (props) => {
  const { t } = useLanguage();
  return <InternalChatErrorBoundary {...props} t={t} />;
};
