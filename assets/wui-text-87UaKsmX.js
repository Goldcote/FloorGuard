const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./add-C-1GG8zb.js","./lit-BUxpUABm.js","./all-wallets-CMRHHKX9.js","./arrow-bottom-circle-aNrVSIAe.js","./app-store-CX55JLn_.js","./apple-3y15zQQo.js","./arrow-bottom-CPSqmNTQ.js","./arrow-left-xfmWEXrX.js","./arrow-right-Dx3JJRtK.js","./arrow-top-BK8s2RXE.js","./bank-tbPyyLOv.js","./browser-G43icNIE.js","./card-DTac9lYG.js","./checkmark-L_Xsktnq.js","./checkmark-bold-CN76Dojk.js","./chevron-bottom-FuqnhH_z.js","./chevron-left-CSm5Qs-4.js","./chevron-right-BWGm2eqq.js","./chevron-top-C6fTUMir.js","./chrome-store-DnCE-hIi.js","./clock-B0a6Dk2x.js","./close-CqhJcRKn.js","./compass-B07XIyft.js","./coinPlaceholder-DsOBMpKa.js","./copy-kOxA6j1a.js","./cursor-G5Tg-FWk.js","./cursor-transparent-BgLW-h50.js","./desktop-DFJ3JBiW.js","./disconnect-DYzymoIt.js","./discord-C1hVik73.js","./etherscan-BsUEIw6f.js","./extension-BQcBoe45.js","./external-link-CO0TW1Ay.js","./facebook-3xUipCPx.js","./farcaster-BW7n63j1.js","./filters-5uT7zNLI.js","./github-BAsSnhzs.js","./google-BOhIqmtA.js","./help-circle-DGwH0Cx5.js","./image-CVz4Wufp.js","./id-DiRpqmiN.js","./info-circle-BbSLNbqb.js","./lightbulb-DqbG4PBg.js","./mail-BnpRabk3.js","./mobile-DyRS7KUf.js","./more-DrTo08ns.js","./network-placeholder-Co7hmXBj.js","./nftPlaceholder-C6GuiuCr.js","./off-CnprmjxF.js","./play-store-xdDNbZ9_.js","./plus-CNousQ2t.js","./qr-code-DoMfa7jb.js","./recycle-horizontal-C8xQherC.js","./refresh-JUpiJIB9.js","./search-B0cC8toB.js","./send-BuWZqhRK.js","./swapHorizontal-CKXpEsuq.js","./swapHorizontalMedium-BGYx3bfd.js","./swapHorizontalBold-R1lwWD8Q.js","./swapHorizontalRoundedBold-CiPh_KI_.js","./swapVertical-BMpSmDSM.js","./telegram-CCmBz8GW.js","./three-dots-Df1wsHGR.js","./twitch-BBT266JH.js","./x-D4o1ExEL.js","./twitterIcon-DRPZ0lGN.js","./verify-B2kgmv1j.js","./verify-filled-BMIgcAVa.js","./wallet-BJT39FiT.js","./walletconnect-ShdQjvgd.js","./wallet-placeholder-Nn7WGaxN.js","./warning-circle-Ckc_o_oS.js","./info-CJR53RkK.js","./exclamation-triangle-DD7Hyf21.js","./reown-logo-BFVN8hK6.js"])))=>i.map(i=>d[i]);
import{t as e}from"./preload-helper-CRzLMJPS.js";import{a as t,n,r}from"./ConstantsUtil-C3VVOplx.js";import{a as i,c as a,i as o,l as s,n as c,r as l,s as u,t as d}from"./lit-BUxpUABm.js";var ee={attribute:!0,type:String,converter:a,reflect:!1,hasChanged:u},te=(e=ee,t,n)=>{let{kind:r,metadata:i}=n,a=globalThis.litPropertyMetadata.get(i);if(a===void 0&&globalThis.litPropertyMetadata.set(i,a=new Map),r===`setter`&&((e=Object.create(e)).wrapped=!0),a.set(n.name,e),r===`accessor`){let{name:r}=n;return{set(n){let i=t.get.call(this);t.set.call(this,n),this.requestUpdate(r,i,e,!0,n)},init(t){return t!==void 0&&this.C(r,void 0,e,t),t}}}if(r===`setter`){let{name:r}=n;return function(n){let i=this[r];t.call(this,n),this.requestUpdate(r,i,e,!0,n)}}throw Error(`Unsupported decorator location: `+r)};function f(e){return(t,n)=>typeof n==`object`?te(e,t,n):((e,t,n)=>{let r=t.hasOwnProperty(n);return t.constructor.createProperty(n,e),r?Object.getOwnPropertyDescriptor(t,n):void 0})(e,t,n)}function p(e){return f({...e,state:!0,attribute:!1})}var m={getSpacingStyles(e,t){if(Array.isArray(e))return e[t]?`var(--wui-spacing-${e[t]})`:void 0;if(typeof e==`string`)return`var(--wui-spacing-${e})`},getFormattedDate(e){return new Intl.DateTimeFormat(`en-US`,{month:`short`,day:`numeric`}).format(e)},getHostName(e){try{return new URL(e).hostname}catch{return``}},getTruncateString({string:e,charsStart:t,charsEnd:n,truncate:r}){return e.length<=t+n?e:r===`end`?`${e.substring(0,t)}...`:r===`start`?`...${e.substring(e.length-n)}`:`${e.substring(0,Math.floor(t))}...${e.substring(e.length-Math.floor(n))}`},generateAvatarColors(e){let t=e.toLowerCase().replace(/^0x/iu,``).replace(/[^a-f0-9]/gu,``).substring(0,6).padEnd(6,`0`),n=this.hexToRgb(t),r=getComputedStyle(document.documentElement).getPropertyValue(`--w3m-border-radius-master`),i=100-3*Number(r?.replace(`px`,``)),a=`${i}% ${i}% at 65% 40%`,o=[];for(let e=0;e<5;e+=1){let t=this.tintColor(n,.15*e);o.push(`rgb(${t[0]}, ${t[1]}, ${t[2]})`)}return`
    --local-color-1: ${o[0]};
    --local-color-2: ${o[1]};
    --local-color-3: ${o[2]};
    --local-color-4: ${o[3]};
    --local-color-5: ${o[4]};
    --local-radial-circle: ${a}
   `},hexToRgb(e){let t=parseInt(e,16);return[t>>16&255,t>>8&255,t&255]},tintColor(e,t){let[n,r,i]=e;return[Math.round(n+(255-n)*t),Math.round(r+(255-r)*t),Math.round(i+(255-i)*t)]},isNumber(e){return{number:/^[0-9]+$/u}.number.test(e)},getColorTheme(e){return e||(typeof window<`u`&&window.matchMedia?window.matchMedia(`(prefers-color-scheme: dark)`)?.matches?`dark`:`light`:`dark`)},splitBalance(e){let t=e.split(`.`);return t.length===2?[t[0],t[1]]:[`0`,`00`]},roundNumber(e,t,n){return e.toString().length>=t?Number(e).toFixed(n):e},formatNumberToLocalString(e,t=2){return e===void 0?`0.00`:typeof e==`number`?e.toLocaleString(`en-US`,{maximumFractionDigits:t,minimumFractionDigits:t}):parseFloat(e).toLocaleString(`en-US`,{maximumFractionDigits:t,minimumFractionDigits:t})}};function h(e,t){let{kind:n,elements:r}=t;return{kind:n,elements:r,finisher(t){customElements.get(e)||customElements.define(e,t)}}}function g(e,t){return customElements.get(e)||customElements.define(e,t),t}function _(e){return function(t){return typeof t==`function`?g(e,t):h(e,t)}}var ne=s`
  :host {
    display: flex;
    width: inherit;
    height: inherit;
  }
`,v=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},y=class extends d{render(){return this.style.cssText=`
      flex-direction: ${this.flexDirection};
      flex-wrap: ${this.flexWrap};
      flex-basis: ${this.flexBasis};
      flex-grow: ${this.flexGrow};
      flex-shrink: ${this.flexShrink};
      align-items: ${this.alignItems};
      justify-content: ${this.justifyContent};
      column-gap: ${this.columnGap&&`var(--wui-spacing-${this.columnGap})`};
      row-gap: ${this.rowGap&&`var(--wui-spacing-${this.rowGap})`};
      gap: ${this.gap&&`var(--wui-spacing-${this.gap})`};
      padding-top: ${this.padding&&m.getSpacingStyles(this.padding,0)};
      padding-right: ${this.padding&&m.getSpacingStyles(this.padding,1)};
      padding-bottom: ${this.padding&&m.getSpacingStyles(this.padding,2)};
      padding-left: ${this.padding&&m.getSpacingStyles(this.padding,3)};
      margin-top: ${this.margin&&m.getSpacingStyles(this.margin,0)};
      margin-right: ${this.margin&&m.getSpacingStyles(this.margin,1)};
      margin-bottom: ${this.margin&&m.getSpacingStyles(this.margin,2)};
      margin-left: ${this.margin&&m.getSpacingStyles(this.margin,3)};
    `,o`<slot></slot>`}};y.styles=[t,ne],v([f()],y.prototype,`flexDirection`,void 0),v([f()],y.prototype,`flexWrap`,void 0),v([f()],y.prototype,`flexBasis`,void 0),v([f()],y.prototype,`flexGrow`,void 0),v([f()],y.prototype,`flexShrink`,void 0),v([f()],y.prototype,`alignItems`,void 0),v([f()],y.prototype,`justifyContent`,void 0),v([f()],y.prototype,`columnGap`,void 0),v([f()],y.prototype,`rowGap`,void 0),v([f()],y.prototype,`gap`,void 0),v([f()],y.prototype,`padding`,void 0),v([f()],y.prototype,`margin`,void 0),y=v([_(`wui-flex`)],y);var re=e=>e??c,{I:ie}=i,b=e=>e===null||typeof e!=`object`&&typeof e!=`function`,ae=e=>e.strings===void 0,x={ATTRIBUTE:1,CHILD:2,PROPERTY:3,BOOLEAN_ATTRIBUTE:4,EVENT:5,ELEMENT:6},S=e=>(...t)=>({_$litDirective$:e,values:t}),C=class{constructor(e){}get _$AU(){return this._$AM._$AU}_$AT(e,t,n){this._$Ct=e,this._$AM=t,this._$Ci=n}_$AS(e,t){return this.update(e,t)}update(e,t){return this.render(...t)}},w=(e,t)=>{let n=e._$AN;if(n===void 0)return!1;for(let e of n)e._$AO?.(t,!1),w(e,t);return!0},T=e=>{let t,n;do{if((t=e._$AM)===void 0)break;n=t._$AN,n.delete(e),e=t}while(n?.size===0)},E=e=>{for(let t;t=e._$AM;e=t){let n=t._$AN;if(n===void 0)t._$AN=n=new Set;else if(n.has(e))break;n.add(e),k(t)}};function D(e){this._$AN===void 0?this._$AM=e:(T(this),this._$AM=e,E(this))}function O(e,t=!1,n=0){let r=this._$AH,i=this._$AN;if(i!==void 0&&i.size!==0){if(t){if(Array.isArray(r))for(let e=n;e<r.length;e++)w(r[e],!1),T(r[e]);else r!=null&&(w(r,!1),T(r))}else w(this,e)}}var k=e=>{e.type==x.CHILD&&(e._$AP??=O,e._$AQ??=D)},A=class extends C{constructor(){super(...arguments),this._$AN=void 0}_$AT(e,t,n){super._$AT(e,t,n),E(this),this.isConnected=e._$AU}_$AO(e,t=!0){e!==this.isConnected&&(this.isConnected=e,e?this.reconnected?.():this.disconnected?.()),t&&(w(this,e),T(this))}setValue(e){if(ae(this._$Ct))this._$Ct._$AI(e,this);else{let t=[...this._$Ct._$AH];t[this._$Ci]=e,this._$Ct._$AI(t,this,0)}}disconnected(){}reconnected(){}},j=class{constructor(e){this.G=e}disconnect(){this.G=void 0}reconnect(e){this.G=e}deref(){return this.G}},oe=class{constructor(){this.Y=void 0,this.Z=void 0}get(){return this.Y}pause(){this.Y??=new Promise(e=>this.Z=e)}resume(){this.Z?.(),this.Y=this.Z=void 0}},M=e=>!b(e)&&typeof e.then==`function`,N=1073741823,P=S(class extends A{constructor(){super(...arguments),this._$Cwt=N,this._$Cbt=[],this._$CK=new j(this),this._$CX=new oe}render(...e){return e.find(e=>!M(e))??l}update(e,t){let n=this._$Cbt,r=n.length;this._$Cbt=t;let i=this._$CK,a=this._$CX;this.isConnected||this.disconnected();for(let e=0;e<t.length&&!(e>this._$Cwt);e++){let o=t[e];if(!M(o))return this._$Cwt=e,o;e<r&&o===n[e]||(this._$Cwt=N,r=0,Promise.resolve(o).then(async e=>{for(;a.get();)await a.get();let t=i.deref();if(t!==void 0){let n=t._$Cbt.indexOf(o);n>-1&&n<t._$Cwt&&(t._$Cwt=n,t.setValue(e))}}))}return l}disconnected(){this._$CK.disconnect(),this._$CX.pause()}reconnected(){this._$CK.reconnect(this),this._$CX.resume()}}),F=new class{constructor(){this.cache=new Map}set(e,t){this.cache.set(e,t)}get(e){return this.cache.get(e)}has(e){return this.cache.has(e)}delete(e){this.cache.delete(e)}clear(){this.cache.clear()}},I=s`
  :host {
    display: flex;
    aspect-ratio: var(--local-aspect-ratio);
    color: var(--local-color);
    width: var(--local-width);
  }

  svg {
    width: inherit;
    height: inherit;
    object-fit: contain;
    object-position: center;
  }

  .fallback {
    width: var(--local-width);
    height: var(--local-height);
  }
`,L=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},R={add:async()=>(await e(async()=>{let{addSvg:e}=await import(`./add-C-1GG8zb.js`);return{addSvg:e}},__vite__mapDeps([0,1]),import.meta.url)).addSvg,allWallets:async()=>(await e(async()=>{let{allWalletsSvg:e}=await import(`./all-wallets-CMRHHKX9.js`);return{allWalletsSvg:e}},__vite__mapDeps([2,1]),import.meta.url)).allWalletsSvg,arrowBottomCircle:async()=>(await e(async()=>{let{arrowBottomCircleSvg:e}=await import(`./arrow-bottom-circle-aNrVSIAe.js`);return{arrowBottomCircleSvg:e}},__vite__mapDeps([3,1]),import.meta.url)).arrowBottomCircleSvg,appStore:async()=>(await e(async()=>{let{appStoreSvg:e}=await import(`./app-store-CX55JLn_.js`);return{appStoreSvg:e}},__vite__mapDeps([4,1]),import.meta.url)).appStoreSvg,apple:async()=>(await e(async()=>{let{appleSvg:e}=await import(`./apple-3y15zQQo.js`);return{appleSvg:e}},__vite__mapDeps([5,1]),import.meta.url)).appleSvg,arrowBottom:async()=>(await e(async()=>{let{arrowBottomSvg:e}=await import(`./arrow-bottom-CPSqmNTQ.js`);return{arrowBottomSvg:e}},__vite__mapDeps([6,1]),import.meta.url)).arrowBottomSvg,arrowLeft:async()=>(await e(async()=>{let{arrowLeftSvg:e}=await import(`./arrow-left-xfmWEXrX.js`);return{arrowLeftSvg:e}},__vite__mapDeps([7,1]),import.meta.url)).arrowLeftSvg,arrowRight:async()=>(await e(async()=>{let{arrowRightSvg:e}=await import(`./arrow-right-Dx3JJRtK.js`);return{arrowRightSvg:e}},__vite__mapDeps([8,1]),import.meta.url)).arrowRightSvg,arrowTop:async()=>(await e(async()=>{let{arrowTopSvg:e}=await import(`./arrow-top-BK8s2RXE.js`);return{arrowTopSvg:e}},__vite__mapDeps([9,1]),import.meta.url)).arrowTopSvg,bank:async()=>(await e(async()=>{let{bankSvg:e}=await import(`./bank-tbPyyLOv.js`);return{bankSvg:e}},__vite__mapDeps([10,1]),import.meta.url)).bankSvg,browser:async()=>(await e(async()=>{let{browserSvg:e}=await import(`./browser-G43icNIE.js`);return{browserSvg:e}},__vite__mapDeps([11,1]),import.meta.url)).browserSvg,card:async()=>(await e(async()=>{let{cardSvg:e}=await import(`./card-DTac9lYG.js`);return{cardSvg:e}},__vite__mapDeps([12,1]),import.meta.url)).cardSvg,checkmark:async()=>(await e(async()=>{let{checkmarkSvg:e}=await import(`./checkmark-L_Xsktnq.js`);return{checkmarkSvg:e}},__vite__mapDeps([13,1]),import.meta.url)).checkmarkSvg,checkmarkBold:async()=>(await e(async()=>{let{checkmarkBoldSvg:e}=await import(`./checkmark-bold-CN76Dojk.js`);return{checkmarkBoldSvg:e}},__vite__mapDeps([14,1]),import.meta.url)).checkmarkBoldSvg,chevronBottom:async()=>(await e(async()=>{let{chevronBottomSvg:e}=await import(`./chevron-bottom-FuqnhH_z.js`);return{chevronBottomSvg:e}},__vite__mapDeps([15,1]),import.meta.url)).chevronBottomSvg,chevronLeft:async()=>(await e(async()=>{let{chevronLeftSvg:e}=await import(`./chevron-left-CSm5Qs-4.js`);return{chevronLeftSvg:e}},__vite__mapDeps([16,1]),import.meta.url)).chevronLeftSvg,chevronRight:async()=>(await e(async()=>{let{chevronRightSvg:e}=await import(`./chevron-right-BWGm2eqq.js`);return{chevronRightSvg:e}},__vite__mapDeps([17,1]),import.meta.url)).chevronRightSvg,chevronTop:async()=>(await e(async()=>{let{chevronTopSvg:e}=await import(`./chevron-top-C6fTUMir.js`);return{chevronTopSvg:e}},__vite__mapDeps([18,1]),import.meta.url)).chevronTopSvg,chromeStore:async()=>(await e(async()=>{let{chromeStoreSvg:e}=await import(`./chrome-store-DnCE-hIi.js`);return{chromeStoreSvg:e}},__vite__mapDeps([19,1]),import.meta.url)).chromeStoreSvg,clock:async()=>(await e(async()=>{let{clockSvg:e}=await import(`./clock-B0a6Dk2x.js`);return{clockSvg:e}},__vite__mapDeps([20,1]),import.meta.url)).clockSvg,close:async()=>(await e(async()=>{let{closeSvg:e}=await import(`./close-CqhJcRKn.js`);return{closeSvg:e}},__vite__mapDeps([21,1]),import.meta.url)).closeSvg,compass:async()=>(await e(async()=>{let{compassSvg:e}=await import(`./compass-B07XIyft.js`);return{compassSvg:e}},__vite__mapDeps([22,1]),import.meta.url)).compassSvg,coinPlaceholder:async()=>(await e(async()=>{let{coinPlaceholderSvg:e}=await import(`./coinPlaceholder-DsOBMpKa.js`);return{coinPlaceholderSvg:e}},__vite__mapDeps([23,1]),import.meta.url)).coinPlaceholderSvg,copy:async()=>(await e(async()=>{let{copySvg:e}=await import(`./copy-kOxA6j1a.js`);return{copySvg:e}},__vite__mapDeps([24,1]),import.meta.url)).copySvg,cursor:async()=>(await e(async()=>{let{cursorSvg:e}=await import(`./cursor-G5Tg-FWk.js`);return{cursorSvg:e}},__vite__mapDeps([25,1]),import.meta.url)).cursorSvg,cursorTransparent:async()=>(await e(async()=>{let{cursorTransparentSvg:e}=await import(`./cursor-transparent-BgLW-h50.js`);return{cursorTransparentSvg:e}},__vite__mapDeps([26,1]),import.meta.url)).cursorTransparentSvg,desktop:async()=>(await e(async()=>{let{desktopSvg:e}=await import(`./desktop-DFJ3JBiW.js`);return{desktopSvg:e}},__vite__mapDeps([27,1]),import.meta.url)).desktopSvg,disconnect:async()=>(await e(async()=>{let{disconnectSvg:e}=await import(`./disconnect-DYzymoIt.js`);return{disconnectSvg:e}},__vite__mapDeps([28,1]),import.meta.url)).disconnectSvg,discord:async()=>(await e(async()=>{let{discordSvg:e}=await import(`./discord-C1hVik73.js`);return{discordSvg:e}},__vite__mapDeps([29,1]),import.meta.url)).discordSvg,etherscan:async()=>(await e(async()=>{let{etherscanSvg:e}=await import(`./etherscan-BsUEIw6f.js`);return{etherscanSvg:e}},__vite__mapDeps([30,1]),import.meta.url)).etherscanSvg,extension:async()=>(await e(async()=>{let{extensionSvg:e}=await import(`./extension-BQcBoe45.js`);return{extensionSvg:e}},__vite__mapDeps([31,1]),import.meta.url)).extensionSvg,externalLink:async()=>(await e(async()=>{let{externalLinkSvg:e}=await import(`./external-link-CO0TW1Ay.js`);return{externalLinkSvg:e}},__vite__mapDeps([32,1]),import.meta.url)).externalLinkSvg,facebook:async()=>(await e(async()=>{let{facebookSvg:e}=await import(`./facebook-3xUipCPx.js`);return{facebookSvg:e}},__vite__mapDeps([33,1]),import.meta.url)).facebookSvg,farcaster:async()=>(await e(async()=>{let{farcasterSvg:e}=await import(`./farcaster-BW7n63j1.js`);return{farcasterSvg:e}},__vite__mapDeps([34,1]),import.meta.url)).farcasterSvg,filters:async()=>(await e(async()=>{let{filtersSvg:e}=await import(`./filters-5uT7zNLI.js`);return{filtersSvg:e}},__vite__mapDeps([35,1]),import.meta.url)).filtersSvg,github:async()=>(await e(async()=>{let{githubSvg:e}=await import(`./github-BAsSnhzs.js`);return{githubSvg:e}},__vite__mapDeps([36,1]),import.meta.url)).githubSvg,google:async()=>(await e(async()=>{let{googleSvg:e}=await import(`./google-BOhIqmtA.js`);return{googleSvg:e}},__vite__mapDeps([37,1]),import.meta.url)).googleSvg,helpCircle:async()=>(await e(async()=>{let{helpCircleSvg:e}=await import(`./help-circle-DGwH0Cx5.js`);return{helpCircleSvg:e}},__vite__mapDeps([38,1]),import.meta.url)).helpCircleSvg,image:async()=>(await e(async()=>{let{imageSvg:e}=await import(`./image-CVz4Wufp.js`);return{imageSvg:e}},__vite__mapDeps([39,1]),import.meta.url)).imageSvg,id:async()=>(await e(async()=>{let{idSvg:e}=await import(`./id-DiRpqmiN.js`);return{idSvg:e}},__vite__mapDeps([40,1]),import.meta.url)).idSvg,infoCircle:async()=>(await e(async()=>{let{infoCircleSvg:e}=await import(`./info-circle-BbSLNbqb.js`);return{infoCircleSvg:e}},__vite__mapDeps([41,1]),import.meta.url)).infoCircleSvg,lightbulb:async()=>(await e(async()=>{let{lightbulbSvg:e}=await import(`./lightbulb-DqbG4PBg.js`);return{lightbulbSvg:e}},__vite__mapDeps([42,1]),import.meta.url)).lightbulbSvg,mail:async()=>(await e(async()=>{let{mailSvg:e}=await import(`./mail-BnpRabk3.js`);return{mailSvg:e}},__vite__mapDeps([43,1]),import.meta.url)).mailSvg,mobile:async()=>(await e(async()=>{let{mobileSvg:e}=await import(`./mobile-DyRS7KUf.js`);return{mobileSvg:e}},__vite__mapDeps([44,1]),import.meta.url)).mobileSvg,more:async()=>(await e(async()=>{let{moreSvg:e}=await import(`./more-DrTo08ns.js`);return{moreSvg:e}},__vite__mapDeps([45,1]),import.meta.url)).moreSvg,networkPlaceholder:async()=>(await e(async()=>{let{networkPlaceholderSvg:e}=await import(`./network-placeholder-Co7hmXBj.js`);return{networkPlaceholderSvg:e}},__vite__mapDeps([46,1]),import.meta.url)).networkPlaceholderSvg,nftPlaceholder:async()=>(await e(async()=>{let{nftPlaceholderSvg:e}=await import(`./nftPlaceholder-C6GuiuCr.js`);return{nftPlaceholderSvg:e}},__vite__mapDeps([47,1]),import.meta.url)).nftPlaceholderSvg,off:async()=>(await e(async()=>{let{offSvg:e}=await import(`./off-CnprmjxF.js`);return{offSvg:e}},__vite__mapDeps([48,1]),import.meta.url)).offSvg,playStore:async()=>(await e(async()=>{let{playStoreSvg:e}=await import(`./play-store-xdDNbZ9_.js`);return{playStoreSvg:e}},__vite__mapDeps([49,1]),import.meta.url)).playStoreSvg,plus:async()=>(await e(async()=>{let{plusSvg:e}=await import(`./plus-CNousQ2t.js`);return{plusSvg:e}},__vite__mapDeps([50,1]),import.meta.url)).plusSvg,qrCode:async()=>(await e(async()=>{let{qrCodeIcon:e}=await import(`./qr-code-DoMfa7jb.js`);return{qrCodeIcon:e}},__vite__mapDeps([51,1]),import.meta.url)).qrCodeIcon,recycleHorizontal:async()=>(await e(async()=>{let{recycleHorizontalSvg:e}=await import(`./recycle-horizontal-C8xQherC.js`);return{recycleHorizontalSvg:e}},__vite__mapDeps([52,1]),import.meta.url)).recycleHorizontalSvg,refresh:async()=>(await e(async()=>{let{refreshSvg:e}=await import(`./refresh-JUpiJIB9.js`);return{refreshSvg:e}},__vite__mapDeps([53,1]),import.meta.url)).refreshSvg,search:async()=>(await e(async()=>{let{searchSvg:e}=await import(`./search-B0cC8toB.js`);return{searchSvg:e}},__vite__mapDeps([54,1]),import.meta.url)).searchSvg,send:async()=>(await e(async()=>{let{sendSvg:e}=await import(`./send-BuWZqhRK.js`);return{sendSvg:e}},__vite__mapDeps([55,1]),import.meta.url)).sendSvg,swapHorizontal:async()=>(await e(async()=>{let{swapHorizontalSvg:e}=await import(`./swapHorizontal-CKXpEsuq.js`);return{swapHorizontalSvg:e}},__vite__mapDeps([56,1]),import.meta.url)).swapHorizontalSvg,swapHorizontalMedium:async()=>(await e(async()=>{let{swapHorizontalMediumSvg:e}=await import(`./swapHorizontalMedium-BGYx3bfd.js`);return{swapHorizontalMediumSvg:e}},__vite__mapDeps([57,1]),import.meta.url)).swapHorizontalMediumSvg,swapHorizontalBold:async()=>(await e(async()=>{let{swapHorizontalBoldSvg:e}=await import(`./swapHorizontalBold-R1lwWD8Q.js`);return{swapHorizontalBoldSvg:e}},__vite__mapDeps([58,1]),import.meta.url)).swapHorizontalBoldSvg,swapHorizontalRoundedBold:async()=>(await e(async()=>{let{swapHorizontalRoundedBoldSvg:e}=await import(`./swapHorizontalRoundedBold-CiPh_KI_.js`);return{swapHorizontalRoundedBoldSvg:e}},__vite__mapDeps([59,1]),import.meta.url)).swapHorizontalRoundedBoldSvg,swapVertical:async()=>(await e(async()=>{let{swapVerticalSvg:e}=await import(`./swapVertical-BMpSmDSM.js`);return{swapVerticalSvg:e}},__vite__mapDeps([60,1]),import.meta.url)).swapVerticalSvg,telegram:async()=>(await e(async()=>{let{telegramSvg:e}=await import(`./telegram-CCmBz8GW.js`);return{telegramSvg:e}},__vite__mapDeps([61,1]),import.meta.url)).telegramSvg,threeDots:async()=>(await e(async()=>{let{threeDotsSvg:e}=await import(`./three-dots-Df1wsHGR.js`);return{threeDotsSvg:e}},__vite__mapDeps([62,1]),import.meta.url)).threeDotsSvg,twitch:async()=>(await e(async()=>{let{twitchSvg:e}=await import(`./twitch-BBT266JH.js`);return{twitchSvg:e}},__vite__mapDeps([63,1]),import.meta.url)).twitchSvg,twitter:async()=>(await e(async()=>{let{xSvg:e}=await import(`./x-D4o1ExEL.js`);return{xSvg:e}},__vite__mapDeps([64,1]),import.meta.url)).xSvg,twitterIcon:async()=>(await e(async()=>{let{twitterIconSvg:e}=await import(`./twitterIcon-DRPZ0lGN.js`);return{twitterIconSvg:e}},__vite__mapDeps([65,1]),import.meta.url)).twitterIconSvg,verify:async()=>(await e(async()=>{let{verifySvg:e}=await import(`./verify-B2kgmv1j.js`);return{verifySvg:e}},__vite__mapDeps([66,1]),import.meta.url)).verifySvg,verifyFilled:async()=>(await e(async()=>{let{verifyFilledSvg:e}=await import(`./verify-filled-BMIgcAVa.js`);return{verifyFilledSvg:e}},__vite__mapDeps([67,1]),import.meta.url)).verifyFilledSvg,wallet:async()=>(await e(async()=>{let{walletSvg:e}=await import(`./wallet-BJT39FiT.js`);return{walletSvg:e}},__vite__mapDeps([68,1]),import.meta.url)).walletSvg,walletConnect:async()=>(await e(async()=>{let{walletConnectSvg:e}=await import(`./walletconnect-ShdQjvgd.js`);return{walletConnectSvg:e}},__vite__mapDeps([69,1]),import.meta.url)).walletConnectSvg,walletConnectLightBrown:async()=>(await e(async()=>{let{walletConnectLightBrownSvg:e}=await import(`./walletconnect-ShdQjvgd.js`);return{walletConnectLightBrownSvg:e}},__vite__mapDeps([69,1]),import.meta.url)).walletConnectLightBrownSvg,walletConnectBrown:async()=>(await e(async()=>{let{walletConnectBrownSvg:e}=await import(`./walletconnect-ShdQjvgd.js`);return{walletConnectBrownSvg:e}},__vite__mapDeps([69,1]),import.meta.url)).walletConnectBrownSvg,walletPlaceholder:async()=>(await e(async()=>{let{walletPlaceholderSvg:e}=await import(`./wallet-placeholder-Nn7WGaxN.js`);return{walletPlaceholderSvg:e}},__vite__mapDeps([70,1]),import.meta.url)).walletPlaceholderSvg,warningCircle:async()=>(await e(async()=>{let{warningCircleSvg:e}=await import(`./warning-circle-Ckc_o_oS.js`);return{warningCircleSvg:e}},__vite__mapDeps([71,1]),import.meta.url)).warningCircleSvg,x:async()=>(await e(async()=>{let{xSvg:e}=await import(`./x-D4o1ExEL.js`);return{xSvg:e}},__vite__mapDeps([64,1]),import.meta.url)).xSvg,info:async()=>(await e(async()=>{let{infoSvg:e}=await import(`./info-CJR53RkK.js`);return{infoSvg:e}},__vite__mapDeps([72,1]),import.meta.url)).infoSvg,exclamationTriangle:async()=>(await e(async()=>{let{exclamationTriangleSvg:e}=await import(`./exclamation-triangle-DD7Hyf21.js`);return{exclamationTriangleSvg:e}},__vite__mapDeps([73,1]),import.meta.url)).exclamationTriangleSvg,reown:async()=>(await e(async()=>{let{reownSvg:e}=await import(`./reown-logo-BFVN8hK6.js`);return{reownSvg:e}},__vite__mapDeps([74,1]),import.meta.url)).reownSvg};async function z(e){if(F.has(e))return F.get(e);let t=(R[e]??R.copy)();return F.set(e,t),t}var B=class extends d{constructor(){super(...arguments),this.size=`md`,this.name=`copy`,this.color=`fg-300`,this.aspectRatio=`1 / 1`}render(){return this.style.cssText=`
      --local-color: ${`var(--wui-color-${this.color});`}
      --local-width: ${`var(--wui-icon-size-${this.size});`}
      --local-aspect-ratio: ${this.aspectRatio}
    `,o`${P(z(this.name),o`<div class="fallback"></div>`)}`}};B.styles=[t,n,I],L([f()],B.prototype,`size`,void 0),L([f()],B.prototype,`name`,void 0),L([f()],B.prototype,`color`,void 0),L([f()],B.prototype,`aspectRatio`,void 0),B=L([_(`wui-icon`)],B);var V=S(class extends C{constructor(e){if(super(e),e.type!==x.ATTRIBUTE||e.name!==`class`||e.strings?.length>2)throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.")}render(e){return` `+Object.keys(e).filter(t=>e[t]).join(` `)+` `}update(e,[t]){if(this.st===void 0){this.st=new Set,e.strings!==void 0&&(this.nt=new Set(e.strings.join(` `).split(/\s/).filter(e=>e!==``)));for(let e in t)t[e]&&!this.nt?.has(e)&&this.st.add(e);return this.render(t)}let n=e.element.classList;for(let e of this.st)e in t||(n.remove(e),this.st.delete(e));for(let e in t){let r=!!t[e];r===this.st.has(e)||this.nt?.has(e)||(r?(n.add(e),this.st.add(e)):(n.remove(e),this.st.delete(e)))}return l}}),H=s`
  :host {
    display: inline-flex !important;
  }

  slot {
    width: 100%;
    display: inline-block;
    font-style: normal;
    font-family: var(--wui-font-family);
    font-feature-settings:
      'tnum' on,
      'lnum' on,
      'case' on;
    line-height: 130%;
    font-weight: var(--wui-font-weight-regular);
    overflow: inherit;
    text-overflow: inherit;
    text-align: var(--local-align);
    color: var(--local-color);
  }

  .wui-line-clamp-1 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
  }

  .wui-line-clamp-2 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  .wui-font-medium-400 {
    font-size: var(--wui-font-size-medium);
    font-weight: var(--wui-font-weight-light);
    letter-spacing: var(--wui-letter-spacing-medium);
  }

  .wui-font-medium-600 {
    font-size: var(--wui-font-size-medium);
    letter-spacing: var(--wui-letter-spacing-medium);
  }

  .wui-font-title-600 {
    font-size: var(--wui-font-size-title);
    letter-spacing: var(--wui-letter-spacing-title);
  }

  .wui-font-title-6-600 {
    font-size: var(--wui-font-size-title-6);
    letter-spacing: var(--wui-letter-spacing-title-6);
  }

  .wui-font-mini-700 {
    font-size: var(--wui-font-size-mini);
    letter-spacing: var(--wui-letter-spacing-mini);
    text-transform: uppercase;
  }

  .wui-font-large-500,
  .wui-font-large-600,
  .wui-font-large-700 {
    font-size: var(--wui-font-size-large);
    letter-spacing: var(--wui-letter-spacing-large);
  }

  .wui-font-2xl-500,
  .wui-font-2xl-600,
  .wui-font-2xl-700 {
    font-size: var(--wui-font-size-2xl);
    letter-spacing: var(--wui-letter-spacing-2xl);
  }

  .wui-font-paragraph-400,
  .wui-font-paragraph-500,
  .wui-font-paragraph-600,
  .wui-font-paragraph-700 {
    font-size: var(--wui-font-size-paragraph);
    letter-spacing: var(--wui-letter-spacing-paragraph);
  }

  .wui-font-small-400,
  .wui-font-small-500,
  .wui-font-small-600 {
    font-size: var(--wui-font-size-small);
    letter-spacing: var(--wui-letter-spacing-small);
  }

  .wui-font-tiny-400,
  .wui-font-tiny-500,
  .wui-font-tiny-600 {
    font-size: var(--wui-font-size-tiny);
    letter-spacing: var(--wui-letter-spacing-tiny);
  }

  .wui-font-micro-700,
  .wui-font-micro-600 {
    font-size: var(--wui-font-size-micro);
    letter-spacing: var(--wui-letter-spacing-micro);
    text-transform: uppercase;
  }

  .wui-font-tiny-400,
  .wui-font-small-400,
  .wui-font-medium-400,
  .wui-font-paragraph-400 {
    font-weight: var(--wui-font-weight-light);
  }

  .wui-font-large-700,
  .wui-font-paragraph-700,
  .wui-font-micro-700,
  .wui-font-mini-700 {
    font-weight: var(--wui-font-weight-bold);
  }

  .wui-font-medium-600,
  .wui-font-medium-title-600,
  .wui-font-title-6-600,
  .wui-font-large-600,
  .wui-font-paragraph-600,
  .wui-font-small-600,
  .wui-font-tiny-600,
  .wui-font-micro-600 {
    font-weight: var(--wui-font-weight-medium);
  }

  :host([disabled]) {
    opacity: 0.4;
  }
`,U=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},W=class extends d{constructor(){super(...arguments),this.variant=`paragraph-500`,this.color=`fg-300`,this.align=`left`,this.lineClamp=void 0}render(){let e={[`wui-font-${this.variant}`]:!0,[`wui-color-${this.color}`]:!0,[`wui-line-clamp-${this.lineClamp}`]:!!this.lineClamp};return this.style.cssText=`
      --local-align: ${this.align};
      --local-color: var(--wui-color-${this.color});
    `,o`<slot class=${V(e)}></slot>`}};W.styles=[t,H],U([f()],W.prototype,`variant`,void 0),U([f()],W.prototype,`color`,void 0),U([f()],W.prototype,`align`,void 0),U([f()],W.prototype,`lineClamp`,void 0),W=U([_(`wui-text`)],W);var G=s`
  :host {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    position: relative;
    overflow: hidden;
    background-color: var(--wui-color-gray-glass-020);
    border-radius: var(--local-border-radius);
    border: var(--local-border);
    box-sizing: content-box;
    width: var(--local-size);
    height: var(--local-size);
    min-height: var(--local-size);
    min-width: var(--local-size);
  }

  @supports (background: color-mix(in srgb, white 50%, black)) {
    :host {
      background-color: color-mix(in srgb, var(--local-bg-value) var(--local-bg-mix), transparent);
    }
  }
`,K=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},q=class extends d{constructor(){super(...arguments),this.size=`md`,this.backgroundColor=`accent-100`,this.iconColor=`accent-100`,this.background=`transparent`,this.border=!1,this.borderColor=`wui-color-bg-125`,this.icon=`copy`}render(){let e=this.iconSize||this.size,t=this.size===`lg`,n=this.size===`xl`,r=t?`12%`:`16%`,i=t?`xxs`:n?`s`:`3xl`,a=this.background===`gray`,s=this.background===`opaque`,c=this.backgroundColor===`accent-100`&&s||this.backgroundColor===`success-100`&&s||this.backgroundColor===`error-100`&&s||this.backgroundColor===`inverse-100`&&s,l=`var(--wui-color-${this.backgroundColor})`;return c?l=`var(--wui-icon-box-bg-${this.backgroundColor})`:a&&(l=`var(--wui-color-gray-${this.backgroundColor})`),this.style.cssText=`
       --local-bg-value: ${l};
       --local-bg-mix: ${c||a?`100%`:r};
       --local-border-radius: var(--wui-border-radius-${i});
       --local-size: var(--wui-icon-box-size-${this.size});
       --local-border: ${this.borderColor===`wui-color-bg-125`?`2px`:`1px`} solid ${this.border?`var(--${this.borderColor})`:`transparent`}
   `,o` <wui-icon color=${this.iconColor} size=${e} name=${this.icon}></wui-icon> `}};q.styles=[t,r,G],K([f()],q.prototype,`size`,void 0),K([f()],q.prototype,`backgroundColor`,void 0),K([f()],q.prototype,`iconColor`,void 0),K([f()],q.prototype,`iconSize`,void 0),K([f()],q.prototype,`background`,void 0),K([f({type:Boolean})],q.prototype,`border`,void 0),K([f()],q.prototype,`borderColor`,void 0),K([f()],q.prototype,`icon`,void 0),q=K([_(`wui-icon-box`)],q);var se=s`
  :host {
    display: block;
    width: var(--local-width);
    height: var(--local-height);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center center;
    border-radius: inherit;
  }
`,J=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},Y=class extends d{constructor(){super(...arguments),this.src=`./path/to/image.jpg`,this.alt=`Image`,this.size=void 0}render(){return this.style.cssText=`
      --local-width: ${this.size?`var(--wui-icon-size-${this.size});`:`100%`};
      --local-height: ${this.size?`var(--wui-icon-size-${this.size});`:`100%`};
      `,o`<img src=${this.src} alt=${this.alt} @error=${this.handleImageError} />`}handleImageError(){this.dispatchEvent(new CustomEvent(`onLoadError`,{bubbles:!0,composed:!0}))}};Y.styles=[t,n,se],J([f()],Y.prototype,`src`,void 0),J([f()],Y.prototype,`alt`,void 0),J([f()],Y.prototype,`size`,void 0),Y=J([_(`wui-image`)],Y);var ce=s`
  :host {
    display: flex;
    justify-content: center;
    align-items: center;
    height: var(--wui-spacing-m);
    padding: 0 var(--wui-spacing-3xs) !important;
    border-radius: var(--wui-border-radius-5xs);
    transition:
      border-radius var(--wui-duration-lg) var(--wui-ease-out-power-1),
      background-color var(--wui-duration-lg) var(--wui-ease-out-power-1);
    will-change: border-radius, background-color;
  }

  :host > wui-text {
    transform: translateY(5%);
  }

  :host([data-variant='main']) {
    background-color: var(--wui-color-accent-glass-015);
    color: var(--wui-color-accent-100);
  }

  :host([data-variant='shade']) {
    background-color: var(--wui-color-gray-glass-010);
    color: var(--wui-color-fg-200);
  }

  :host([data-variant='success']) {
    background-color: var(--wui-icon-box-bg-success-100);
    color: var(--wui-color-success-100);
  }

  :host([data-variant='error']) {
    background-color: var(--wui-icon-box-bg-error-100);
    color: var(--wui-color-error-100);
  }

  :host([data-size='lg']) {
    padding: 11px 5px !important;
  }

  :host([data-size='lg']) > wui-text {
    transform: translateY(2%);
  }
`,X=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},Z=class extends d{constructor(){super(...arguments),this.variant=`main`,this.size=`lg`}render(){this.dataset.variant=this.variant,this.dataset.size=this.size;let e=this.size===`md`?`mini-700`:`micro-700`;return o`
      <wui-text data-variant=${this.variant} variant=${e} color="inherit">
        <slot></slot>
      </wui-text>
    `}};Z.styles=[t,ce],X([f()],Z.prototype,`variant`,void 0),X([f()],Z.prototype,`size`,void 0),Z=X([_(`wui-tag`)],Z);var le=s`
  :host {
    display: flex;
  }

  :host([data-size='sm']) > svg {
    width: 12px;
    height: 12px;
  }

  :host([data-size='md']) > svg {
    width: 16px;
    height: 16px;
  }

  :host([data-size='lg']) > svg {
    width: 24px;
    height: 24px;
  }

  :host([data-size='xl']) > svg {
    width: 32px;
    height: 32px;
  }

  svg {
    animation: rotate 2s linear infinite;
  }

  circle {
    fill: none;
    stroke: var(--local-color);
    stroke-width: 4px;
    stroke-dasharray: 1, 124;
    stroke-dashoffset: 0;
    stroke-linecap: round;
    animation: dash 1.5s ease-in-out infinite;
  }

  :host([data-size='md']) > svg > circle {
    stroke-width: 6px;
  }

  :host([data-size='sm']) > svg > circle {
    stroke-width: 8px;
  }

  @keyframes rotate {
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes dash {
    0% {
      stroke-dasharray: 1, 124;
      stroke-dashoffset: 0;
    }

    50% {
      stroke-dasharray: 90, 124;
      stroke-dashoffset: -35;
    }

    100% {
      stroke-dashoffset: -125;
    }
  }
`,Q=function(e,t,n,r){var i=arguments.length,a=i<3?t:r===null?r=Object.getOwnPropertyDescriptor(t,n):r,o;if(typeof Reflect==`object`&&typeof Reflect.decorate==`function`)a=Reflect.decorate(e,t,n,r);else for(var s=e.length-1;s>=0;s--)(o=e[s])&&(a=(i<3?o(a):i>3?o(t,n,a):o(t,n))||a);return i>3&&a&&Object.defineProperty(t,n,a),a},$=class extends d{constructor(){super(...arguments),this.color=`accent-100`,this.size=`lg`}render(){return this.style.cssText=`--local-color: ${this.color===`inherit`?`inherit`:`var(--wui-color-${this.color})`}`,this.dataset.size=this.size,o`<svg viewBox="25 25 50 50">
      <circle r="20" cy="50" cx="50"></circle>
    </svg>`}};$.styles=[t,le],Q([f()],$.prototype,`color`,void 0),Q([f()],$.prototype,`size`,void 0),$=Q([_(`wui-loading-spinner`)],$);export{_ as a,f as c,re as i,A as n,m as o,S as r,p as s,V as t};