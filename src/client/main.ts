import { createApp } from "vue";
import { createPinia } from "pinia";
import "phoenix-wing/style.css";
import App from "./App.vue";
import "./styles.css";

createApp(App).use(createPinia()).mount("#app");
