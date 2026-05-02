import './globals.css';
import Providers from './providers.jsx';

export const metadata = {
  title: 'Crypto Bot Dashboard',
  description: 'Mean-reversion futures bot console',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
