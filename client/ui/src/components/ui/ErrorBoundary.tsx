import React from 'react';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
  copied?: boolean;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryStrings {
  unknownError: string;
  title: string;
  description: string;
  detailsSummary: string;
  componentStackLabel: string;
  tryAgain: string;
  copied: string;
  copy: string;
}

interface InnerErrorBoundaryProps extends ErrorBoundaryProps {
  strings: ErrorBoundaryStrings;
}

class InnerErrorBoundary extends React.Component<InnerErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: InnerErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    this.setState({ error, errorInfo, copied: false });

    console.error('Error caught by boundary:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  handleCopy = async () => {
    const { strings } = this.props;
    const errorText = this.state.error ? String(this.state.error) : strings.unknownError;
    const stack = this.state.error?.stack ? `\n\nStack:\n${this.state.error.stack}` : '';
    const componentStack = this.state.errorInfo?.componentStack ? `\n\n${strings.componentStackLabel}${this.state.errorInfo.componentStack}` : '';
    const payload = `${errorText}${stack}${componentStack}`;

    const result = await copyTextToClipboard(payload);
    if (result.ok) {
      this.setState({ copied: true });
      window.setTimeout(() => {
        this.setState((prev) => (prev.copied ? { copied: false } : null));
      }, 1500);
    }
  };

  render() {
    const { strings } = this.props;

    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="p-4 flex items-center justify-center min-h-screen">
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <CardTitle className="flex items-center justify-center gap-2 text-destructive">
                <Icon name="error-warning" className="h-5 w-5" />
                {strings.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {strings.description}
              </p>

              {this.state.error && (
                <details className="text-xs font-mono bg-muted p-3 rounded">
                  <summary className="cursor-pointer hover:bg-interactive-hover/80">{strings.detailsSummary}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto">
                    {this.state.error.toString()}
                    {this.state.errorInfo?.componentStack ? `\n\n${strings.componentStackLabel}${this.state.errorInfo.componentStack}` : ''}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button onClick={this.handleReset} variant="outline" className="flex-1">
                  <Icon name="restart" className="h-4 w-4 mr-2" />
                  {strings.tryAgain}
                </Button>
                <Button onClick={this.handleCopy} variant="outline" className="flex-1">
                  {this.state.copied ? strings.copied : strings.copy}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

export const ErrorBoundary: React.FC<ErrorBoundaryProps> = ({ children, fallback }) => {
  const { t } = useI18n();

  const strings: ErrorBoundaryStrings = React.useMemo(() => ({
    unknownError: t('errorBoundary.state.unknownError'),
    title: t('errorBoundary.title'),
    description: t('errorBoundary.description'),
    detailsSummary: t('errorBoundary.actions.errorDetails'),
    componentStackLabel: t('errorBoundary.state.componentStackLabel'),
    tryAgain: t('errorBoundary.actions.tryAgain'),
    copied: t('errorBoundary.actions.copied'),
    copy: t('errorBoundary.actions.copy'),
  }), [t]);

  return (
    <InnerErrorBoundary fallback={fallback} strings={strings}>
      {children}
    </InnerErrorBoundary>
  );
};
