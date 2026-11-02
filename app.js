/*
 * Atelier v3 — Firebase-backed QR ordering
 * Uses Firebase compat SDK from CDN so the project stays plain HTML/CSS/JS.
 */
const RESTAURANT_ID = "DCZQA4alj7FwcwoFj2vb";
const $ = (selector) => document.querySelector(selector);
const money = (value) => `RM ${Number(value || 0).toFixed(2)}`;
const params = new URLSearchParams(window.location.search);
const table = params.get("table") || "1";

let cart = JSON.parse(localStorage.getItem("atelier-cart") || "[]");
let menu = [];
let categories = [];
let activeCategory = "All";
let currentUser = null;
let ordersUnsubscribe = null;
let kitchenUser = false;
let staffProfile = null;
let customerOrdersUnsubscribe = null;
let loyaltyUnsubscribe = null;

$("#tableNumber").textContent = table;
$("#cartTable").textContent = table;
$("#checkoutTable").textContent = table;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2600);
}
function saveCart(){ localStorage.setItem("atelier-cart", JSON.stringify(cart)); }
function showCart(open){
  $("#cartOverlay").classList.toggle("open",open);
  $("#cartOverlay").setAttribute("aria-hidden",String(!open));
}
function showCheckout(open){
  $("#checkoutModal").classList.toggle("open",open);
  $("#checkoutModal").setAttribute("aria-hidden",String(!open));
}
function firebaseReady(){
  return window.firebase && window.FIREBASE_CONFIG &&
    window.FIREBASE_CONFIG.apiKey !== "PASTE_API_KEY_HERE" &&
    window.FIREBASE_CONFIG.appId !== "PASTE_APP_ID_HERE";
}
function initFirebase(){
  if(!firebaseReady()){
    showToast("Add your Firebase Web App config in firebase-config.js");
    $("#menuGrid").innerHTML = `<p class="connection-note">Firebase is not configured yet. Add your Web App config to <code>firebase-config.js</code>, then reload.</p>`;
    return false;
  }
  if(!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
  window.auth = firebase.auth();
  window.db = firebase.firestore();
  return true;
}

function renderCategories(){
  const names = ["All", ...categories.map(c=>c.name).filter(Boolean)];
  $("#categories").innerHTML = names.map(name =>
    `<button class="category-button ${name===activeCategory?"active":""}" data-category="${escapeHtml(name)}">${escapeHtml(name)}</button>`
  ).join("");
  document.querySelectorAll("[data-category]").forEach(button => button.addEventListener("click",()=>{
    activeCategory=button.dataset.category;renderCategories();renderMenu();
  }));
}
function escapeHtml(value){
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function renderMenu(){
  const term=$("#searchInput").value.toLowerCase().trim();
  const filtered=menu.filter(item=>(activeCategory==="All"||item.category===activeCategory) &&
    (`${item.name} ${item.description||""} ${(item.ingredients||[]).join(" ")}`.toLowerCase().includes(term)));
  $("#menuGrid").innerHTML=filtered.length?filtered.map(item=>`
    <article class="menu-card">
      <div class="food-image" ${item.image?`style="background-image:url('${escapeHtml(item.image)}')"`:""}>${item.tag?`<span class="food-tag">${escapeHtml(item.tag)}</span>`:""}</div>
      <div class="menu-card-content"><div class="food-meta"><h3>${escapeHtml(item.name)}</h3><span class="price">${money(item.price)}</span></div>
      <p class="food-description">${escapeHtml(item.description||"")}</p>
      <p class="food-description">${item.prepTimeMinutes?`About ${Number(item.prepTimeMinutes)} min`:''}</p>
      <button class="add-button" data-add="${escapeHtml(item.id)}" ${item.isAvailable===false?"disabled":""}>＋ ADD TO ORDER</button></div>
    </article>`).join(""):`<p>No dishes found. Add menu items in Firestore or change your search.</p>`;
  document.querySelectorAll("[data-add]").forEach(button=>button.addEventListener("click",()=>addToCart(button.dataset.add)));
}
async function loadMenu(){
  try{
    const [catsSnap,itemsSnap]=await Promise.all([
      db.collection("menuCategories").where("restaurantId","==",RESTAURANT_ID).where("isActive","==",true).get(),
      db.collection("menuItems").where("restaurantId","==",RESTAURANT_ID).where("isAvailable","==",true).get()
    ]);
    categories=catsSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));
    const catById=new Map(categories.map(c=>[c.id,c.name]));
    menu=itemsSnap.docs.map(d=>{
      const data=d.data();
      return {id:d.id,...data,category:catById.get(data.categoryId)||"Other"};
    });
    renderCategories();renderMenu();renderCart();
    if(!menu.length) $("#menuGrid").innerHTML="<p>No available dishes yet. Add an active menu item in Firestore.</p>";
  }catch(error){
    console.error(error);
    $("#menuGrid").innerHTML=`<p class="connection-note">Could not load the menu: ${escapeHtml(error.message)}. Check Firestore rules and collection fields.</p>`;
  }
}

function renderCustomerOrders(snapshot){
  const orders=snapshot.docs.map(d=>({id:d.id,...d.data()}));
  const host=$("#customerOrders");
  if(!orders.length){
    host.innerHTML='<p class="dashboard-empty">No orders yet. Your orders will show up here after checkout.</p>';
    return;
  }
  host.innerHTML=orders.slice(0,6).map(order=>{
    const steps=["Pending","Preparing","Ready","Completed"];
    const current=Math.max(0,steps.indexOf(order.status));
    const statusLabel=order.status==="Completed"?"Completed":order.status==="Ready"?"Ready for collection":"Being prepared";
    return `<article class="customer-order">
      <div class="customer-order-top"><div><span class="order-reference">ORDER #${escapeHtml(order.id.slice(0,8).toUpperCase())}</span><strong>${money(order.total)}</strong></div><span class="customer-status">${escapeHtml(statusLabel)}</span></div>
      <p class="customer-order-meta">Table ${escapeHtml(order.tableNumber)} · ${orderTime(order.createdAt)}</p>
      <div class="order-progress">${steps.map((step,index)=>`<span class="progress-step ${index<=current?"done":""}"><i></i>${step}</span>`).join("")}</div>
      <p class="customer-order-items">${(order.items||[]).map(item=>`${Number(item.quantity)} × ${escapeHtml(item.name)}`).join(" · ")}</p>
    </article>`;
  }).join("");
}
function startCustomerDashboard(user){
  if(customerOrdersUnsubscribe){customerOrdersUnsubscribe();customerOrdersUnsubscribe=null;}
  if(loyaltyUnsubscribe){loyaltyUnsubscribe();loyaltyUnsubscribe=null;}
  customerOrdersUnsubscribe=db.collection("orders")
    .where("customerUid","==",user.uid)
    .orderBy("createdAt","desc")
    .limit(6)
    .onSnapshot(renderCustomerOrders,error=>{
      console.error(error);
      $("#customerOrders").innerHTML=`<p class="dashboard-empty">Could not load orders: ${escapeHtml(error.message)}</p>`;
    });
  loyaltyUnsubscribe=db.collection("loyalty").doc(user.uid).onSnapshot(doc=>{
    const data=doc.exists?doc.data():{};
    $("#loyaltyPoints").textContent=Number(data.points||0).toLocaleString();
    $("#loyaltyLifetime").textContent=data.totalPointsEarned
      ? `${Number(data.totalPointsEarned).toLocaleString()} points earned in total.`
      : "Complete your first order to earn points.";
  },error=>{
    console.error(error);
    $("#loyaltyLifetime").textContent="Rewards are temporarily unavailable.";
  });
}

function addToCart(id){
  const item=cart.find(entry=>entry.id===id);
  if(item)item.quantity++;else cart.push({id,quantity:1});
  saveCart();renderCart();showToast("Added to your order");
}
function changeQuantity(id,change){
  const item=cart.find(entry=>entry.id===id);if(!item)return;
  item.quantity+=change;cart=cart.filter(entry=>entry.quantity>0);
  saveCart();renderCart();
}
function renderCart(){
  const count=cart.reduce((sum,item)=>sum+item.quantity,0);
  const total=cart.reduce((sum,entry)=>sum+(menu.find(d=>d.id===entry.id)?.price||0)*entry.quantity,0);
  $("#cartCount").textContent=count;$("#subtotal").textContent=money(total);
  $("#checkoutButton").disabled=count===0;
  $("#cartItems").innerHTML=cart.length?cart.map(entry=>{
    const dish=menu.find(item=>item.id===entry.id);
    if(!dish)return "";
    return `<div class="cart-item"><div><h4>${escapeHtml(dish.name)}</h4><small>${money(dish.price)} each</small></div>
    <div class="quantity"><button data-change="${escapeHtml(dish.id)}" data-step="-1">−</button><strong>${entry.quantity}</strong><button data-change="${escapeHtml(dish.id)}" data-step="1">＋</button></div></div>`;
  }).join(""):`<div class="empty-cart">Your basket is waiting for something delicious.</div>`;
  document.querySelectorAll("[data-change]").forEach(button=>button.addEventListener("click",()=>changeQuantity(button.dataset.change,Number(button.dataset.step))));
}
function calcTotal(items){
  return items.reduce((sum,entry)=>sum+(menu.find(d=>d.id===entry.id)?.price||0)*entry.quantity,0);
}
async function placeOrder(event){
  event.preventDefault();
  if(!cart.length||!currentUser)return;
  const payment=new FormData($("#checkoutForm")).get("payment");
  const items=cart.map(entry=>{
    const dish=menu.find(d=>d.id===entry.id);
    return {menuItemId:dish.id,name:dish.name,price:Number(dish.price),quantity:entry.quantity};
  });
  const total=items.reduce((sum,item)=>sum+item.price*item.quantity,0);
  const paymentStatus=payment==="Pay at terminal"?"Pay at counter":payment==="Kaspi Bank transfer"?"Awaiting confirmation":"Awaiting payment";
  const order={
    restaurantId:RESTAURANT_ID,tableNumber:Number(table)||1,
    customerName:$("#customerName").value.trim()||"Guest",
    customerUid:currentUser.uid,paymentMethod:payment,paymentStatus,
    total,currency:"MYR",items,status:"Pending",
    createdAt:firebase.firestore.FieldValue.serverTimestamp()
  };
  try{
    const ref=await db.collection("orders").add(order);
    cart=[];saveCart();renderCart();showCheckout(false);showCart(false);$("#checkoutForm").reset();
    showToast(`Order ${ref.id.slice(0,8)} sent to the kitchen`);
  }catch(error){console.error(error);showToast(`Order failed: ${error.message}`);}
}
function orderTime(value){
  if(!value)return "Just now";
  const date=value.toDate?value.toDate():new Date(value);
  return date.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
}
function renderKitchen(snapshot){
  const orders=snapshot.docs.map(d=>({id:d.id,...d.data()}));
  const active=orders.filter(o=>o.status!=="Completed");
  $("#activeCount").textContent=active.length;
  $("#completedCount").textContent=orders.filter(o=>o.status==="Completed").length;
  $("#orderBoard").innerHTML=orders.length?orders.map(order=>`
    <article class="order-card">
      <p class="eyebrow">${escapeHtml(order.id.slice(0,8))} · ${orderTime(order.createdAt)}</p>
      <h3>Table ${escapeHtml(order.tableNumber)}</h3>
      <p>${escapeHtml(order.customerName||"Guest")} · ${escapeHtml(order.paymentMethod||"")}</p>
      <ul>${(order.items||[]).map(item=>`<li>${Number(item.quantity)} × ${escapeHtml(item.name)}</li>`).join("")}</ul>
      <p><strong>${money(order.total)}</strong></p>
      <div class="payment-row"><span class="eyebrow">PAYMENT</span><strong class="payment-status ${order.paymentStatus==="Paid"?"is-paid":"is-unpaid"}">${escapeHtml(order.paymentStatus||"Awaiting payment")}</strong></div>
      ${order.paymentStatus!=="Paid"?`<button class="mark-paid-button" data-paid="${escapeHtml(order.id)}">MARK PAYMENT AS RECEIVED</button>`:`<p class="paid-note">✓ Payment confirmed</p>`}
      <label class="eyebrow status-label" for="status-${escapeHtml(order.id)}">ORDER STATUS</label>
      <select class="status-select" id="status-${escapeHtml(order.id)}" data-status="${escapeHtml(order.id)}">
        ${["Pending","Preparing","Ready","Completed"].map(s=>`<option ${order.status===s?"selected":""}>${s}</option>`).join("")}
      </select>
    </article>`).join(""):`<p>No orders yet. New orders will appear here automatically.</p>`;
  document.querySelectorAll("[data-status]").forEach(select=>select.addEventListener("change",()=>{
    if(select.value==="Completed") completeOrderAndAwardPoints(select.dataset.status);
    else {
  console.log("STATUS UPDATE TEST:", {
    orderId: select.dataset.status,
    newStatus: select.value,
    uid: firebase.auth().currentUser?.uid,
    isAnonymous: firebase.auth().currentUser?.isAnonymous
  });
  updateOrder(select.dataset.status,{status:select.value});
}
  }));
  document.querySelectorAll("[data-paid]").forEach(button=>button.addEventListener("click",()=>markPaid(button.dataset.paid)));
}
async function updateOrder(id,patch){
  try{
    await db.collection("orders").doc(id).update({...patch,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
  }catch(error){
    console.error(error);
    showToast(`Update failed: ${error.message}`);
    throw error;
  }
}

async function completeOrderAndAwardPoints(id) {
  const orderRef = db.collection("orders").doc(id);

  try {
    await db.runTransaction(async (transaction) => {
      const orderSnap = await transaction.get(orderRef);

      if (!orderSnap.exists) {
        throw new Error("Order not found");
      }

      const order = orderSnap.data();

      if (order.restaurantId !== RESTAURANT_ID) {
        throw new Error("This order belongs to another restaurant");
      }

     if (order.status === "Completed" || order.loyaltyAwarded === true) {
  return;
}

      const points = Math.max(
        0,
        Math.floor(Number(order.total || 0))
      );

      const loyaltyRef = db.collection("loyalty").doc(order.customerUid);

      transaction.set(loyaltyRef, {
        customerUid: order.customerUid,
        restaurantId: RESTAURANT_ID,
        points: firebase.firestore.FieldValue.increment(points),
        totalPointsEarned: firebase.firestore.FieldValue.increment(points),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      transaction.update(orderRef, {
        status: "Completed",
        loyaltyAwarded: true,
        loyaltyPointsAwarded: points,
        completedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });

    showToast("Order completed");

  } catch (error) {
    console.error(error);
    showToast(`Could not complete order: ${error.message}`);
  }
}
async function markPaid(id){
  // Demo-only manual confirmation. Real payment must be verified by a trusted payment provider/server.
  try{
    await updateOrder(id,{paymentStatus:"Paid",paidAt:firebase.firestore.FieldValue.serverTimestamp()});
    showToast("Payment marked as received");
  }catch(error){ /* updateOrder already displays the error */ }
}
function stopKitchenListener(){
  if(ordersUnsubscribe){ordersUnsubscribe();ordersUnsubscribe=null;}
}
async function showKitchen(){
  $("#customerView").classList.add("hidden");$("#kitchenView").classList.remove("hidden");
  const next=new URL(location.href);next.searchParams.set("view","kitchen");history.replaceState({},"",next);
  $("#staffLogin").classList.remove("hidden");$("#kitchenContent").classList.add("hidden");
  if(auth.currentUser && !auth.currentUser.isAnonymous) await verifyStaff(auth.currentUser);
}
async function verifyStaff(user){
  try{
    const doc=await db.collection("staff").doc(user.uid).get();
    if(!doc.exists||doc.data().isActive!==true||doc.data().restaurantId!==RESTAURANT_ID){
      staffProfile=null;$("#staffLoginError").textContent="This account is not authorised for this restaurant.";
      await auth.signOut();return false;
    }
    staffProfile=doc.data();
    $("#staffLogin").classList.add("hidden");$("#kitchenContent").classList.remove("hidden");
    stopKitchenListener();
    ordersUnsubscribe=db.collection("orders").where("restaurantId","==",RESTAURANT_ID).orderBy("createdAt","desc").onSnapshot(renderKitchen,error=>{
      console.error(error);showToast(`Kitchen sync error: ${error.message}`);
    });
    return true;
  }catch(error){console.error(error);$("#staffLoginError").textContent=error.message;return false;}
}
function toggleKitchen(show){
  if(show) showKitchen();
  else{
    stopKitchenListener();$("#kitchenView").classList.add("hidden");$("#customerView").classList.remove("hidden");
    const next=new URL(location.href);next.searchParams.delete("view");history.replaceState({},"",next);
  }
}
async function init(){
  if(!initFirebase())return;
  auth.onAuthStateChanged(async user=>{
    if(user){
      currentUser=user;
      if(user.isAnonymous) {
        await loadMenu();
        startCustomerDashboard(user);
      } else if(new URLSearchParams(window.location.search).get("view")==="kitchen") {
        await verifyStaff(user);
      } else {
        startCustomerDashboard(user);
        await loadMenu();
      }
    }else{
      try{await auth.signInAnonymously();}catch(error){console.error(error);showToast(`Authentication error: ${error.message}`);}
    }
  });
}
$("#searchInput").addEventListener("input",renderMenu);
$("#openCart").addEventListener("click",()=>showCart(true));
$("#closeCart").addEventListener("click",()=>showCart(false));
$("#cartOverlay").addEventListener("click",e=>{if(e.target===$("#cartOverlay"))showCart(false);});
$("#checkoutButton").addEventListener("click",()=>{showCart(false);showCheckout(true);});
$("#closeCheckout").addEventListener("click",()=>showCheckout(false));
$("#checkoutModal").addEventListener("click",e=>{if(e.target===$("#checkoutModal"))showCheckout(false);});
$("#checkoutForm").addEventListener("submit",placeOrder);
$("#kitchenToggle").addEventListener("click",()=>toggleKitchen(true));
$("#backToMenu").addEventListener("click",()=>toggleKitchen(false));
$("#staffLoginForm").addEventListener("submit",async e=>{
  e.preventDefault();$("#staffLoginError").textContent="";
  try{const cred=await auth.signInWithEmailAndPassword($("#staffEmail").value.trim(),$("#staffPassword").value);}
  catch(error){$("#staffLoginError").textContent="Sign-in failed. Check email/password and try again.";}
});
if(initFirebase()) {
  if(params.get("view")==="kitchen") { $("#customerView").classList.add("hidden");$("#kitchenView").classList.remove("hidden"); }
  init();
} else {
  // Keep the page navigable enough to show the setup message.
  renderCart();
}
