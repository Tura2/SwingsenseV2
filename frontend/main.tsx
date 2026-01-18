import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, createHashRouter, RouterProvider } from "react-router-dom";
import routes from "./routes";
import "./styles.css";

const isFileProtocol = typeof window !== "undefined" && window.location.protocol === "file:";
const router = isFileProtocol ? createHashRouter(routes) : createBrowserRouter(routes);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
