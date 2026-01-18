import { RouteObject } from "react-router-dom";
import App from "./App";
import Home from "./pages/Home";
import Ticker from "./pages/Ticker";
import Watchlists from "./pages/Watchlists";
import Portfolio from "./pages/Portfolio";
import Signals from "./pages/Signals";
import Backtest from "./pages/Backtest";
import TsmomCommandCenter from "./pages/TsmomCommandCenter";
import Wealth from "./pages/Wealth";

const routes: RouteObject[] = [
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Home /> },
      { path: "ticker", element: <Ticker /> },
      { path: "watchlists", element: <Watchlists /> },
      { path: "portfolio", element: <Portfolio /> },
      { path: "wealth", element: <Wealth /> },
      { path: "signals", element: <Signals /> },
      { path: "backtest", element: <Backtest /> },
      { path: "tsmom", element: <TsmomCommandCenter /> }
    ]
  }
];

export default routes;
