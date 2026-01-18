import { NavLink } from "react-router-dom";

export default function Nav() {
  return (
    <nav>
      <h1>swingsenseV2</h1>
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/ticker">Ticker</NavLink>
      <NavLink to="/watchlists">Watchlists</NavLink>
      <NavLink to="/portfolio">Portfolio</NavLink>
      <NavLink to="/signals">Signals</NavLink>
      <NavLink to="/backtest">Backtest</NavLink>
      <NavLink to="/tsmom">TSMOM</NavLink>
    </nav>
  );
}
