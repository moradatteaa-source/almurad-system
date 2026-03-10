import { db } from "./firebase.js";
import { ref, onValue } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const container = document.getElementById("products");

onValue(ref(db,"shop/products"),(snapshot)=>{

container.innerHTML="";

snapshot.forEach(child=>{

const p = child.val();

container.innerHTML+=`

<div class="product-card">

<img src="${p.image}">

<h3>${p.name}</h3>

<p>${p.price} IQD</p>

</div>

`;

});

});