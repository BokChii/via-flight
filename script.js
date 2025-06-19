/* ---------- 전역 변수 ---------- */
let map, infowindow, startMarker;
let currentStartLocation = null, currentStartLocationName = "";
let itineraryDestinations = [];        // [{ name, location, details, place_id, duration }]
let destinationAutocomplete, startAutocomplete;
let directionsRenderers = [], poiMarkers = [], categoryMarkers = [];
let selectedTimezone = 'local';        // 기본값은 현지 시간
// 05.31 시간 모드 변수 추가
let isUsingCurrentTime = true // 기본값: 현재 시간 사용

// 06.03 실시간 추적 gps 관련 추가
/* ---------- 실시간 추적 관련 변수 ---------- */
let watchId = null;                    // GPS 추적 ID
let currentPosition = null;            // 현재 위치
let userLocationMarker = null;         // 사용자 위치 마커
let isTrackingActive = false;          // 추적 활성화 상태
let visitedDestinations = [];          // 방문 완료한 목적지들
let lastLocationUpdate = null;         // 마지막 위치 업데이트 시간
// 06.07 네비게이션 지도 관련 변수 (새로 추가)
let isMapFollowingUser = false;      // 사용자 따라가기 모드
let mapDragTimeout = null;           // 드래그 감지 타이머
let lastUserHeading = 0;             // 마지막 사용자 방향
let isMapRotationEnabled = false;    // 지도 회전 활성화 여부

// 추적 설정 (구글맵 네비게이션과 유사하게)
const TRACKING_OPTIONS = {
  enableHighAccuracy: true,    // 높은 정확도
  timeout: 15000,             // 10초 타임아웃 > 15초
  maximumAge: 3000            // 5초간 캐시 허용 > 3초
};

const VISIT_DETECTION_RADIUS = 50;     // 방문 감지 반경 (50미터 - 변경 가능! (고려 필요ㅠㅠ))
const POSITION_UPDATE_INTERVAL = 3000;  // 3초마다 업데이트 (부드러운 추적)


/* 경로·카테고리 색상 */
const routeColors = ["#ff3355","#2196f3","#4caf50","#ff9800","#9c27b0","#009688"];
const categoryIcons = {
  tourist_attraction:"http://maps.google.com/mapfiles/ms/icons/orange-dot.png",
  restaurant        :"http://maps.google.com/mapfiles/ms/icons/red-dot.png",
  cafe              :"http://maps.google.com/mapfiles/ms/icons/brown-dot.png",
  lodging           :"http://maps.google.com/mapfiles/ms/icons/blue-dot.png",
  shopping_mall     :"http://maps.google.com/mapfiles/ms/icons/purple-dot.png",
  airport           :"http://maps.google.com/mapfiles/ms/icons/green-dot.png",
  park              :"http://maps.google.com/mapfiles/ms/icons/yellow-dot.png",
  museum            :"http://maps.google.com/mapfiles/ms/icons/pink-dot.png"
};

/* ---------- 모달 요소 (POI 상세 정보 페이지) ---------- */
const modal     = document.getElementById("destination-modal");
const modalBody = document.getElementById("modal-body");
document.querySelector(".close").onclick = () => (modal.style.display = "none");
window.onclick  = e => { if (e.target === modal) modal.style.display = "none"; };

/* 환승 시간 관련 추가 코드 */
const arrivalInput = document.getElementById("arrival-time");
const layoverInput = document.getElementById("layover-time");
const timezoneSelect = document.getElementById("timezone-select");
const loadingOverlay = document.getElementById("loading-overlay");

// 시간대 선택 이벤트 리스너
if (timezoneSelect) {
  timezoneSelect.addEventListener('change', function() {
    selectedTimezone = this.value;
  });
}

/* ---------- 유틸 ---------- */
function transformTypes(t){
  if(!t?.length) return "정보 없음";
  const ignore = ["point_of_interest","establishment"];
  const m = { tourist_attraction:"관광명소", restaurant:"식당", cafe:"카페", lodging:"숙박",
              shopping_mall:"쇼핑몰", airport:"공항", park:"공원", museum:"박물관" };
  return t.filter(x=>!ignore.includes(x)).map(x=>m[x]||x).join(", ") || "정보 없음";
}

function calculateDistance(a,b){
  const R=6371, dLat=(b.lat()-a.lat())*Math.PI/180, dLon=(b.lng()-a.lng())*Math.PI/180;
  const h=Math.sin(dLat/2)**2+Math.cos(a.lat()*Math.PI/180)*Math.cos(b.lat()*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));
}

const formatDuration = s => { 
  const m=Math.round(s/60), h=Math.floor(m/60); 
  return (h?`${h}시간 `:"")+`${m%60}분`; 
};

// 통합된 시간 변환 함수 (12시간제 → 24시간제)
function convertTo24h(timeStr) {
  // "10:00 AM" 형식 또는 ["10:00", "AM"] 배열 형식 모두 처리
  let hours, minutes, period;
  
  if (Array.isArray(timeStr)) {
    [hours, minutes] = timeStr[0].split(':').map(Number);
    period = timeStr[1];
  } else if (typeof timeStr === 'string' && timeStr.includes(' ')) {
    const parts = timeStr.split(' ');
    [hours, minutes] = parts[0].split(':').map(Number);
    period = parts[1];
  } else {
    // 기타 형식이면 그대로 반환
    return timeStr;
  }
  
  if (period === "PM" && hours < 12) hours += 12;
  if (period === "AM" && hours === 12) hours = 0;
  
  return `${hours.toString().padStart(2,"0")}:${minutes.toString().padStart(2,"0")}`;
}

// 시간대 조정 함수
function adjustForTimezone(date) {
  if (selectedTimezone === 'local') return date;
  
  const tzOffset = parseFloat(selectedTimezone);
  if (isNaN(tzOffset)) return date;
  
  // 시간대 조정을 위한 새 날짜 객체 생성
  const adjustedDate = new Date(date);
  
  // UTC 시간으로 변환 후 선택한 시간대로 조정
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  adjustedDate.setTime(utc + (3600000 * tzOffset));
  
  return adjustedDate;
}

/* ---------- 마커/리셋 ---------- */
function createMarker(pos,title,icon){
  const m = new google.maps.Marker({ map, position:pos, title, icon });
  poiMarkers.push(m); return m;
}

function clearCategoryMarkers(){
  categoryMarkers.forEach(m=>m.setMap(null));
  categoryMarkers=[];
}

function resetAll(){
  // 06.03 resetall 관련 세부 기능 추가
  itineraryDestinations=[]; 
  document.getElementById("itinerary-list").innerHTML="";
  document.getElementById("route-details").innerHTML="";
  document.getElementById("destination-search-results").innerHTML="";

  // 목적지 검색창 초기화
  const destinationSearch = document.getElementById("destination-search");
  if(destinationSearch) {
    destinationSearch.value = "";
  }
  // startmarker를 제외한 나머지 마커들만 제거
  poiMarkers.forEach(m=>{
    if(m !== startMarker) {
      m.setMap(null);
    }
  }); 
  poiMarkers=[];
  clearCategoryMarkers();
  directionsRenderers.forEach(r=>r.setMap(null)); 
  directionsRenderers=[];
  
  // 출발지가 설정되어 있으면 출발지로 이동, 없으면 서울(deafualt)로 이동
  if(currentStartLocation) {
    map.setCenter(currentStartLocation);
    map.setZoom(13);
    // 출발지 마커는 유지 (startmarker 제거 ㄴㄴ)
  } else{
    // 출발지가 없으면 기존처럼 서울로 이동
    map.setCenter({lat:37.5665,lng:126.9780});
    map.setZoom(13);
    // startmarker도 없으므로 제거할 필요 없음
    if(startMarker){ 
      startMarker.setMap(null); 
      startMarker=null; 
    }
  }
}
document.getElementById("reset-button").onclick = resetAll;

/* ---------- 페이지네이션 ---------- */
function paginateResults(res,box,render){
  const per=5, total=Math.ceil(res.length/per); // POI 리스트 5개씩 정리(페이지 구분)
  const paint = p=>{
    box.innerHTML="";
    res.slice((p-1)*per, p*per).forEach(x=>box.appendChild(render(x)));
    if(total>1){
      const nav=document.createElement("div"); nav.className="pagination";
      for(let i=1;i<=total;i++){
        const b=document.createElement("button"); b.textContent=i; b.disabled=i===p;
        b.onclick=()=>paint(i); nav.appendChild(b);
      } box.appendChild(nav);
    }
  }; paint(1);
}

/* 05.31 */
/* 운영 시간 확인 함수 개선 */
function isOpenNow(opening_hours, useSpecificTime = null) {
  // 시간 결정: 명시적으로 지정된 시간 또는 모드에 따른 시간
  const referenceTime = useSpecificTime || (isUsingCurrentTime ? new Date() : (arrivalInput.value ? new Date(arrivalInput.value) : new Date()));
  const timeMode = isUsingCurrentTime ? "현재 시간" : "환승 도착 시간";
  
  console.log(`운영 시간 확인 중 (${timeMode} 모드:`, referenceTime.toLocaleString(), ")");
  
  // 운영 시간 정보가 없으면 운영 중으로 간주
  if (!opening_hours) {
    console.log("운영 시간 정보 없음 - 운영 중으로 간주");
    return true;
  }

  // 06.05 특정 시간이 지정된 경우(환승 도착 시간 모드)에는 open_now 무시하고 periods 로만 판단
  const shouldIgnoreOpneNow = useSpecificTime != null || isUsingCurrentTime;
  
  // 1. periods 배열을 통해 지정된 시간에 영업 중인지 확인
  if (opening_hours.periods && Array.isArray(opening_hours.periods)) {
    try {
      const day = referenceTime.getDay(); // 0(일) ~ 6(토)
      const hours = referenceTime.getHours();
      const minutes = referenceTime.getMinutes();
      const currentMinutes = hours * 60 + minutes;
      
      console.log("확인 시간:", day, hours, minutes);
      console.log("periods 데이터:", opening_hours.periods);
      
      // periods 배열을 순회하며 현재 시간이 영업 시간 내인지 확인
      // 06.05 24시간 운영 관련 예외 처리 추가
      for (const period of opening_hours.periods) {
        if (period.open) {
          // close가 없으면 24시간 운영으로 간주
          if (!period.close) {
            console.log("24시간 영업 (periods - close 속성 없음)");
            return true;
          }
          const openDay = period.open.day;
          const closeDay = period.close.day;
          
          // time은 "0930"과 같은 형식
          const openHours = parseInt(period.open.time.substring(0, 2));
          const openMinutes = parseInt(period.open.time.substring(2));
          const openTotalMinutes = openHours * 60 + openMinutes;
          
          const closeHours = parseInt(period.close.time.substring(0, 2));
          const closeMinutes = parseInt(period.close.time.substring(2));
          const closeTotalMinutes = closeHours * 60 + closeMinutes;
          
          console.log(`영업시간: ${openDay} ${openHours}:${openMinutes}~${closeDay} ${closeHours}:${closeMinutes}`);
          
          // 같은 날 영업하는 경우
          if (openDay === closeDay && openDay === day) {
            if (openTotalMinutes <= currentMinutes && currentMinutes < closeTotalMinutes) {
              console.log(`${timeMode} 기준 영업 중 (periods - 당일)`);
              return true;
            }
          } 
          // 자정을 넘어가는 영업시간
          else if (openDay === day && closeDay === (day + 1) % 7) {
            if (openTotalMinutes <= currentMinutes) {
              console.log(`${timeMode} 기준 영업 중 (periods - 자정 넘김)`);
              return true;
            }
          } 
          // 전날부터 이어지는 영업시간
          else if (openDay === (day - 1 + 7) % 7 && closeDay === day) {
            if (currentMinutes < closeTotalMinutes) {
              console.log(`${timeMode} 기준 영업 중 (periods - 전날부터)`);
              return true;
            }
          }
          // 24시간 영업 (공식 API에서는 이렇게 표현한다고 함)
          else if (openDay === 0 && closeDay === 0 && period.open.time === "0000" && period.close.time === "0000") {
            console.log("24시간 영업 (periods 기준)");
            return true;
          }
        }
      }

      // 06.05 periods로 확인했을 때 운영 중이 아니면 바로 false 반환 (특정 시간 모드일 때)
      if (shouldIgnoreOpneNow) {
        console.log(`${timeMode} 기준 운영 종료 (periods 확인 완료)`);
        return false;
      }
    } catch (e) {
      console.error("periods 처리 오류:", e);
    }
  }
  
  // 2. weekday_text로 현재 영업 중인지 확인
  if (opening_hours.weekday_text && Array.isArray(opening_hours.weekday_text)) {
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const today = days[referenceTime.getDay()]; // 변경: now -> referenceTime
    
    const dayText = opening_hours.weekday_text.find(text => text.startsWith(today));
    if (dayText) {
      console.log("해당 요일의 영업 시간 텍스트:", dayText);
      
      // 24시간 영업 확인
      if (dayText.toLowerCase().includes("open 24") || 
          dayText.toLowerCase().includes("24 hour") ||
          dayText.toLowerCase().includes("24시간") ||
          dayText.toLowerCase().includes("24/7")) {
        console.log("24시간 영업 (weekday_text 기준)");
        return true;
      }
      
      // 영업 시간 추출해서 현재 시간과 비교
      const timeRangeMatch = dayText.match(/(\d+:\d+\s[AP]M)\s*[–-]\s*(\d+:\d+\s[AP]M)/);
      if (timeRangeMatch) {
        const [, openTimeStr, closeTimeStr] = timeRangeMatch;
        console.log("시간 범위:", openTimeStr, "-", closeTimeStr);
        
        try {
          const currentHours = referenceTime.getHours();  // 변경: now -> referenceTime
          const currentMinutes = referenceTime.getMinutes();
          
          const openHours = convertTo24h(openTimeStr);
          const closeHours = convertTo24h(closeTimeStr);
          
          const currentTime = `${currentHours.toString().padStart(2, '0')}:${currentMinutes.toString().padStart(2, '0')}`;
          console.log("확인 시간:", currentTime, "영업 시간:", openHours, "~", closeHours);
          
          const currentValue = currentHours * 60 + currentMinutes;
          const [openH, openM] = openHours.split(':').map(Number);
          const [closeH, closeM] = closeHours.split(':').map(Number);
          const openValue = openH * 60 + openM;
          const closeValue = closeH * 60 + closeM;
          
          // 자정을 넘어가는 케이스
          if (closeValue < openValue) {
            const isOpen = currentValue >= openValue || currentValue <= closeValue;
            console.log(`자정을 넘어가는 케이스, ${timeMode} 기준 영업 중:`, isOpen);
            return isOpen;
          } else {
            const isOpen = currentValue >= openValue && currentValue <= closeValue;
            console.log(`일반 케이스, ${timeMode} 기준 영업 중:`, isOpen);
            return isOpen;
          }
        } catch (e) {
          console.error("시간 비교 오류:", e);
        }
      }
    }
  }
  
  // 3. 모든 요일이 24시간 운영인지 확인
  if (opening_hours && opening_hours.weekday_text) {
    const is24hLocation = opening_hours.weekday_text.every(text => 
      text.includes("Open 24 hours") || text.includes("24 hours") || text.includes("24/7")
    );
    
    if (is24hLocation) {
      console.log("모든 요일 24시간 운영");
      return true;
    }
  }
  
  // 4. 이름으로 24시간 운영 장소 인식
  const containerElement = document.querySelector('.modal-content') || document.getElementById('itinerary-list');
  if (containerElement) {
    const placeNameElement = containerElement.querySelector('h2') || containerElement.querySelector('.itinerary-name');
    if (placeNameElement) {
      const placeName = placeNameElement.textContent.toLowerCase();
      const known24hPlaces = ["merlion", "멀라이언", "머라이언", "merlion park", "멀라이언 파크", "머라이언 파크"];
      if (known24hPlaces.some(name => placeName.includes(name))) {
        console.log("이름으로 24시간 장소 인식:", placeName);
        return true;
      }
    }
  }
  
  // 5. open_now 속성 직접 접근 시도 (버전에 따라 작동할 수도 있음)
  // 06.05 환승 시간 모드 관련 코드 추가
  if(!shouldIgnoreOpneNow){
    try {
      // 일부 브라우저/버전에서는 직접 접근이 가능할 수 있음
      if (typeof opening_hours.open_now !== 'undefined') {
        console.log("open_now 직접 접근:", opening_hours.open_now);
        return opening_hours.open_now === true;
      }
      
      // 접근자(accessor)를 위한 특수 케이스
      const openNowDesc = Object.getOwnPropertyDescriptor(opening_hours, 'open_now');
      if (openNowDesc && typeof openNowDesc.get === 'function') {
        const value = openNowDesc.get.call(opening_hours);
        console.log("open_now 접근자 호출:", value);
        return value === true;
      }
    } catch (e) {
      console.error("open_now 접근 오류:", e);
    }
  }
  //06.05 특정 시간 모드에서는 여기까지 왔으면 운영 종료
  if (shouldIgnoreOpneNow) {
    console.log(`${timeMode} 기준 운영 종료로 판단`);
    return false
  }

  // 위의 모든 방법으로도 판단할 수 없으면 기본으로 true 반환 (대부분 영업 중으로 간주)
  console.log(`운영 시간 판단 불가 - ${timeMode} 기준으로 운영 중으로 간주`);
  return true;
}

/* ---------- POI 카드 ---------- */
function renderPlaceItem(place){
  const div=document.createElement("div"); div.className="destination-item";

  // 장소 설명 정보 처리 개선
  const desc=place.editorial_summary?.short_description||place.vicinity||"설명이 없습니다.";

  // 거리 계산 부분 유지
  const dist=currentStartLocation&&place.geometry?.location
      ? ` | 거리: ${calculateDistance(currentStartLocation,place.geometry.location).toFixed(1)} km` : "";
      
  // 카테고리 및 평점 정보가 없을 때 대체 문구 수정
  const categoryText = place.types && place.types.length > 0 
                      ? transformTypes(place.types) 
                      : "정보 없음";
  
  const ratingText = place.rating 
                    ? `평균 평점: ${place.rating}` 
                    : "평균 평점: 정보 없음";

// 운영 상태 확인 및 표시
let openStatus = "";
if (place.opening_hours) {
  // 선택된 시간 모드에 따라 참조 시간 결정
  const referenceTime = isUsingCurrentTime ? 
    new Date() : 
    (arrivalInput.value ? new Date(arrivalInput.value) : new Date());
  
  const isOpen = isOpenNow(place.opening_hours, referenceTime);
  const modeText = isUsingCurrentTime ? "" : "환승 시간에 ";
  openStatus = `<span class="poi-status" style="color:${isOpen ? '#007700' : '#bb0000'}">
                  <b>${modeText}${isOpen ? '운영 중' : '운영 종료'}</b>
                </span>`;
}
  
  div.innerHTML = `<strong>${place.name}</strong><br>
                   <span class="poi-description">${desc}</span><br>
                   <span class="poi-description"><b>카테고리:</b> ${categoryText}</span><br>
                   <span class="poi-description"><b>${ratingText}${dist}</b></span>
                   ${openStatus}`;
  
  div.onclick = ()=>{ 
    if(place.geometry?.location) map.panTo(place.geometry.location); 
    showDestinationModal(place); 
  };
  
  const btn = document.createElement("button"); 
  btn.textContent="일정 추가";
  btn.onclick = e=>{ e.stopPropagation(); addDestinationToItinerary(place); };
  div.appendChild(btn); return div;
}

/* ---------- 모달 ---------- */
function showDestinationModal(place){
  // 로딩 표시 시작
  modalBody.innerHTML = '<div class="modal-loading">정보를 불러오는 중...</div>';
  modal.style.display = "block";
  
  const svc = new google.maps.places.PlacesService(map);
  svc.getDetails({
    placeId: place.place_id,
    fields: ["place_id", "name","formatted_address","formatted_phone_number","opening_hours",
             "rating","reviews","website","types","photos","editorial_summary"]
  }, (r, st) => {
    if(st !== "OK") {
      modalBody.innerHTML = `<div class="error-message">
        <h3>상세 정보를 불러오지 못했습니다</h3>
        <p>오류: ${st || '알 수 없는 오류'}</p>
        <p>잠시 후 다시 시도해주세요.</p>
      </div>`;
      return;
    }

    // 원래 place_id가 없을 경우 추가
    if (!r.place_id && place.place_id){
      r.place_id = place.place_id;
    }
    
    const img = r.photos?.[0]?.getUrl({maxWidth: 500, maxHeight: 300}); // 적용 안되는 경우 있는 것 같음.
    let h=`<h2>${r.name}</h2>`;
    if(img) h += `<img src="${img}" style="width:100%;border-radius:6px;margin-bottom:8px;">`;
    if(r.formatted_address)       h+=`<p><b>주소:</b> ${r.formatted_address}</p>`;
    if(r.formatted_phone_number)  h+=`<p><b>전화:</b> ${r.formatted_phone_number}</p>`;
    if(r.rating)                  h+=`<p><b>평점:</b> ${r.rating}</p>`;
    if(r.types?.length)           h+=`<p><b>카테고리:</b> ${transformTypes(r.types)}</p>`;
    
    // 운영 시간 표시 개선
    if (r.opening_hours) {
      // 선택된 시간 모드에 따라 참조 시간 결정
      const referenceTime = isUsingCurrentTime ? 
        new Date() : 
        (arrivalInput.value ? new Date(arrivalInput.value) : new Date());
      
      const isOpenNowValue = isOpenNow(r.opening_hours, referenceTime);
      const modeText = isUsingCurrentTime ? "현재" : "환승 도착 시간";
      
      h += `<p>
        <b>${modeText} 기준 상태:</b> 
        <span style="color:${isOpenNowValue ? '#007700' : '#bb0000'};font-weight:bold;">
          ${isOpenNowValue ? '운영 중' : '운영 종료'}
        </span>
      </p>`;
      
      if (r.opening_hours.weekday_text?.length) {
        h += `<p><b>운영 시간:</b><br>`;
        r.opening_hours.weekday_text.forEach(line => {
          // 24시간 영업 표시 강화
          if (line.includes("Open 24 hours") || line.toLowerCase().includes("24시간") || 
              line.toLowerCase().includes("open 24") || line.toLowerCase().includes("24/7")) {
            h += `<span style="color:#007700">${line}</span><br>`;
          } else {
            h += `${line}<br>`;
          }
        });
        h += `</p>`;
      }
    }
    
    h+=`<p>${r.editorial_summary?.short_description||"추가 설명이 없습니다."}</p>`;
    if(r.website) h+=`<p><a href="${r.website}" target="_blank">웹사이트</a></p>`;
    
    if(r.reviews?.length){
      h+=`<h4>방문자 리뷰</h4>`;
      r.reviews.slice(0,5).forEach(v=>{
        const stars="★".repeat(Math.round(v.rating))+"☆".repeat(5-Math.round(v.rating));
        h+=`<div style="margin-bottom:8px;">
               <span style="font-weight:bold;">${v.author_name}</span>
               <span style="color:#f4b400;">${stars}</span><br>
               <span style="font-size:.9em;">${v.relative_time_description}</span>
               <p style="margin:4px 0 0">"${v.text}"</p>
            </div>`;
      });
    }
    
    // 일정에 추가 버튼과 머무는 시간 입력창 추가
    h += `
      <div class="add-to-schedule">
        <div class="duration-input-group">
          <label for="modal-duration">머무는 시간(분):</label>
          <input type="number" id="modal-duration" value="60" min="1" max="240" style="width:60px">
        </div>
        <button id="modal-add-btn">일정에 추가</button>
      </div>
    `;

    modalBody.innerHTML=h;

    // 버튼 핸들러
    document.getElementById("modal-add-btn").onclick = () => {
      // 머무는 시간 가져오기
      const durationInput = document.getElementById("modal-duration");
      const duration = parseInt(durationInput.value);
      
      // 유효성 검사
      if (isNaN(duration) || duration < 1 || duration > 240) {
        alert("머무는 시간은 1분에서 240분(4시간) 사이여야 합니다.");
        return;
      }

      // 추가 디버깅 로그
      if (!r.place_id) {
        console.error("place_id가 없습니다:", r);
        alert("장소 ID를 찾을 수 없습니다. 다시 시도해주세요.");
        return;
      }
      
      // 머무는 시간과 함께 일정에 추가
      addDestinationToItinerary(r, duration);
      modal.style.display = "none";
    };
  });
}

/* 특정 시간에 운영 중인지 확인하는 함수 추가 */
function isOpenAtTime(opening_hours, time) {
  return isOpenNow(opening_hours, time);
}

/* ---------- 일정 추가 / 리스트 ---------- */
function addDestinationToItinerary(place, customDuration){
  // 디버깅 로그 추가
  console.log("일정에 추가하는 장소:", place);

  if(!place.place_id){
    console.error("place_id가 없습니다. 일정 추가 실패.");
    alert("장소 ID를 찾을 수 없습니다. 다시 시도해주세요.");
    return;
  }

  if(itineraryDestinations.some(p=>p.place_id===place.place_id)) {
    alert("이미 추가된 목적지입니다.");
    return;
  }
  
  // 로딩 표시
  const tempMessage = document.createElement('div');
  tempMessage.className = 'temp-message';
  tempMessage.textContent = '장소 정보 로딩 중...';
  document.getElementById('itinerary-list').appendChild(tempMessage);
  
  new google.maps.places.PlacesService(map).getDetails(
    {
      placeId: place.place_id,
      // 디버깅 용으로 place_id 필드 추가함.
      fields: ["place_id", "name", "formatted_address", "rating", "geometry", "types", "opening_hours"]
    },
    (r, st) => {
      // 메시지 제거
      if (tempMessage.parentNode) {
        tempMessage.parentNode.removeChild(tempMessage);
      }
      
      if(st !== "OK") {
        alert("상세 정보 불러오기 실패: " + st);
        return;
      }
      
      // place_id가 없으면 원본에서 복사
      if (!r.place_id && place.place_id) {
        r.place_id = place.place_id;
      }
      
      // 24시간 영업 여부 확인
      let is24h = false;
      
      // 이름으로 24시간 장소 확인 (예외 상황 추가 필요)
      const known24hPlaces = ["merlion", "멀라이언", "머라이언", "merlion park", "멀라이언 파크", "머라이언 파크"];
      if (known24hPlaces.some(placeName => r.name.toLowerCase().includes(placeName.toLowerCase()))) {
        is24h = true;
      }
      // 운영 시간 텍스트로 24시간 검사 (필수적인 부분 같음)
      if (r.opening_hours?.weekday_text) {
        const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const today = days[new Date().getDay()];
        
        const dayText = r.opening_hours.weekday_text.find(text => text.startsWith(today));
        if (dayText && (
            dayText.toLowerCase().includes("24 hour") || 
            dayText.toLowerCase().includes("24시간") || 
            dayText.toLowerCase().includes("open 24") || 
            dayText.toLowerCase().includes("24/7"))) {
          is24h = true;
        }
      }
      
      // 운영 시간 체크 (현재 시간 기준)
      if (!isOpenNow(r.opening_hours) && !is24h) {
        // 추가는 하지만 경고 표시
        const confirmAdd = confirm("현재 이 장소는 운영 중이 아닙니다. 그래도 일정에 추가하시겠습니까?");
        if (!confirmAdd) return;
      }
      
      itineraryDestinations.push({
        name: r.name,
        location: r.geometry.location,
        details: r,
        place_id: r.place_id,
        // poi 기본 체류 시간 60분으로 설정 또는 사용자가 모달에서 지정한 체류 시간 사용!
        duration: customDuration || 60,
        is24h: is24h
      });
      
      displayItinerary();
    }
  );
}

function displayItinerary(){
  const box=document.getElementById("itinerary-list"); 
  box.innerHTML="";
  
  // 일정이 없을 때 메시지 표시
  if (itineraryDestinations.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'empty-message';
    emptyMsg.textContent = '아직 추가된 일정이 없습니다.';
    box.appendChild(emptyMsg);
    return;
  }
  
  // Sortable 설정 (드래그 앤 드롭 기능)
  if (typeof Sortable !== 'undefined') {
    new Sortable(box, {
      animation: 150,
      ghostClass: 'dragging',
      onEnd: function() {
        // 드래그 앤 드롭으로 순서 변경 후 배열 업데이트
        const items = box.querySelectorAll('.itinerary-item');
        const newOrder = [];
        
        items.forEach(item => {
          const placeId = item.dataset.placeId;
          const destination = itineraryDestinations.find(d => d.place_id === placeId);
          if (destination) newOrder.push(destination);
        });
        
        itineraryDestinations = newOrder;
      }
    });
  }
  
  itineraryDestinations.forEach((p, i) => {
    const div = document.createElement("div");
    div.className = "itinerary-item";
    div.dataset.placeId = p.place_id;

    // 운영 시간 확인 및 표시 / 개선된 코드
    // 선택된 시간 모드에 따라 참조 시간 결정
    const referenceTime = isUsingCurrentTime ? 
    new Date() : 
    (arrivalInput.value ? new Date(arrivalInput.value) : new Date());
    
    const isOpen = isOpenNow(p.details.opening_hours, referenceTime);
    let openText = isOpen ? "운영 중" : "운영 종료";
    let openColor = isOpen ? "#007700" : "#bb0000";

    // 24시간 운영 여부 확인
    let is24h = p.is24h || false;
    
    // 이름으로 24시간 장소 검사 (이미 저장된 속성이 없을 경우)
    if (!is24h) {
      const known24hPlaces = ["merlion", "멀라이언", "머라이언", "merlion park", "멀라이언 파크", "머라이언 파크"];
      if (known24hPlaces.some(placeName => p.name.toLowerCase().includes(placeName.toLowerCase()))) {
        is24h = true;
        p.is24h = true;
      }
    }
    
    // 운영 시간 텍스트로 24시간 검사 (이미 저장된 속성이 없을 경우)
    if (!is24h && p.details.opening_hours?.weekday_text) {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const today = days[new Date().getDay()];
      
      const dayText = p.details.opening_hours.weekday_text.find(text => text.startsWith(today));
      if (dayText && (
          dayText.toLowerCase().includes("24 hour") || 
          dayText.toLowerCase().includes("24시간") || 
          dayText.toLowerCase().includes("open 24") || 
          dayText.toLowerCase().includes("24/7"))) {
        is24h = true;
        p.is24h = true;
      }
    }

    if (is24h) {
      openText = "24시간 운영";
      openColor = "#007700";
    } else if (!isUsingCurrentTime) { // 환승 시간 모드일 때만 추가 표시
      openText = isOpen ? "환승 시간에 운영 중" : "환승 시간에 운영 안함";
    }

    // 머무는 시간, poi 체류 시간 표시
    div.innerHTML = `
      <span class="itinerary-name">${p.name}</span>
      <span class="poi-description"><b>카테고리:</b> ${transformTypes(p.details.types)}</span>
      <span class="poi-description" style="color:${openColor};"><b>${openText}</b></span>
      <label>머무는 시간(분):
        <input type="number" class="visit-duration" value="${p.duration}" min="1" max="240" style="width:60px">
      </label>
    `;
    
    div.querySelector(".visit-duration").onchange = e => {
      const v = parseInt(e.target.value);
      if (v > 0 && v <= 240) {
        itineraryDestinations[i].duration = v;
      } else {
        alert("체류 시간은 1분에서 240분(4시간) 사이여야 합니다.");
        e.target.value = itineraryDestinations[i].duration;
      }
    };
    
    div.onclick = () => {
      map.panTo(p.location);
      showDestinationModal({ place_id: p.place_id });
    };
    
    const rm = document.createElement("button");
    rm.textContent = "삭제";
    rm.className = "remove-button";
    rm.onclick = e => { 
      e.stopPropagation(); 
      itineraryDestinations.splice(i, 1); 
      displayItinerary(); 
    };

    div.appendChild(rm); 
    box.appendChild(div);
  });
}

/* ---------- 드래그‑구간 하이라이트 ---------- */
function focusLeg(bounds, renderer, color){
  map.fitBounds(bounds);
  renderer.setOptions({polylineOptions:{strokeColor:color, strokeWeight:8}});
  setTimeout(()=>renderer.setOptions({polylineOptions:{strokeColor:color, strokeWeight:5}}), 1500);
}

function extractLegInfo(leg){
  return `<p><b>출발:</b> ${leg.start_address}</p>
          <p><b>도착:</b> ${leg.end_address}</p>
          <p><b>소요:</b> ${leg.duration.text}</p>`;
}

function displayLegOnMap(res, color){
  const renderer=new google.maps.DirectionsRenderer({
    map, suppressMarkers:true, polylineOptions:{strokeColor:color, strokeWeight:5}
  });
  renderer.setDirections(res); directionsRenderers.push(renderer);
  const leg=res.routes[0].legs[0];
  createMarker(leg.start_location,"출발","http://maps.google.com/mapfiles/ms/icons/green-dot.png");
  createMarker(leg.end_location,"도착","http://maps.google.com/mapfiles/ms/icons/red-dot.png");
  const b=new google.maps.LatLngBounds(); b.extend(leg.start_location); b.extend(leg.end_location);
  return {bounds:b, renderer};
}

/* ---------- Directions & 최적 경로 ---------- */
function getPermutations(arr){
  // 최적화: 너무 많은 목적지는 제한
  if (arr.length > 8) {
    alert("경로 계산 성능을 위해 최대 8개 장소로 제한합니다.");
    return [arr.slice(0, 8)];
  }
  
  if(!arr.length) return [[]];
  const out=[];
  arr.forEach((v,i)=>{
    const rest=[...arr.slice(0,i),...arr.slice(i+1)];
    getPermutations(rest).forEach(p=>out.push([v,...p]));
  });
  return out;
}

function getTransitRoute(o, d){
  return new Promise((res, rej)=>{
    new google.maps.DirectionsService().route(
      {origin:o, destination:d, travelMode:"TRANSIT", transitOptions:{departureTime:new Date()}},
      (r, st)=>st==="OK"?res(r):rej(st)
    );
  });
}

// 개선된 운영 시간 기반 필터링 함수
function filterPlacesByLayover(arrivalTime, layoverTime) {
  if (!arrivalTime || isNaN(layoverTime)) return [];
  
  const adjustedArrival = adjustForTimezone(arrivalTime);
  const endTime = new Date(adjustedArrival.getTime() + layoverTime * 60000);
  
  // 먼저 결과를 로깅해서 디버깅
  console.log("필터링 시작:", new Date().toISOString());
  console.log("도착 시간:", adjustedArrival);
  console.log("환승 종료 시간:", endTime);
  console.log("전체 장소 수:", itineraryDestinations.length);
  
  const filtered = itineraryDestinations.filter(p => {
    // 운영 시간 정보 로깅
    console.log(`장소: ${p.name}`);
    console.log("운영 시간 정보:", p.details.opening_hours);
    
    // 이미 저장된 24시간 운영 여부 확인
    if (p.is24h === true) {
      console.log("장소에 24시간 운영 속성 적용됨");
      return true;
    }

    // 멀라이언 파크 등 널리 알려진 24시간 장소 이름으로 확인
    const known24hPlaces = ["merlion", "멀라이언", "머라이언", "merlion park", "멀라이언 파크", "머라이언 파크"];
    if (known24hPlaces.some(placeName => p.name.toLowerCase().includes(placeName.toLowerCase()))) {
      console.log("24시간 장소로 인식:", p.name);
      p.is24h = true;
      return true;
    }
     
    // 운영 시간 정보가 없거나 비어있으면 운영 중으로 가정 (특히 공원 등)
    if (!p.details.opening_hours) {
      console.log("운영 시간 정보 없음 - 방문 가능으로 처리");
      return true;
    }
     
    // 명시적으로 "open_now"가 true이면 운영 중
    if (isOpenNow(p.details.opening_hours)) {
      console.log("현재 운영 중 표시됨");
      return true;
    }
     
    // 운영 시간 텍스트 체크
    if (p.details.opening_hours.weekday_text) {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const today = days[adjustedArrival.getDay()];
       
      const dayText = p.details.opening_hours.weekday_text.find(text => text.startsWith(today));
      console.log("오늘 요일:", today);
      console.log("운영 시간 텍스트:", dayText);
       
      // 24시간 운영 키워드 체크 (06.19 확인 -> 24시간 운영 예외처리 코드 수정 필요)
      if (dayText && (
          dayText.toLowerCase().includes("24 hour") || 
          dayText.toLowerCase().includes("24시간") || 
          dayText.toLowerCase().includes("open 24") || 
          dayText.toLowerCase().includes("24/7"))) {
        console.log("24시간 운영 텍스트 확인됨");
        p.is24h = true;
        return true;
      }
    }
     
    // 방문 시작 시간이 영업 시간 내에 있는지
    const visitStartOk = isOpenAtTime(p.details.opening_hours, adjustedArrival);
    console.log("방문 시작 가능:", visitStartOk);
     
    // 방문 종료 시간이 환승 종료 시간 이전인지
    const stayEndTime = new Date(adjustedArrival.getTime() + p.duration * 60000);
    const stayEndOk = stayEndTime <= endTime;
    console.log("체류 종료 시간:", stayEndTime);
    co요sole.log("환승 종료 시간 내 방문 가능:", stayEndOk);
     
    return visitStartOk && stayEndOk;
  });
   
  console.log("필터링 결과 장소 수:", filtered.length);
  return filtered;
}

async function generateOptimalRoute() {
  // 필수 값 확인
  if(!currentStartLocation) {
    alert("먼저 출발지를 설정해주세요.");
    return;
  }
  if(!itineraryDestinations.length) {
    alert("일정에 목적지를 추가해주세요.");
    return;
  }

  // 06.07 시간 모드별 유효성 검사 (수정된 부분)
  if (!validateCurrentTimeMode()) {
    return;
  }
  
  // 사용자 입력 읽기 (수정된 부분)
  const arrivalTime = getCurrentTimeModeArrivalTime();
  const layoverTime = parseInt(document.getElementById("layover-time").value);
  
  if (isNaN(layoverTime)) {
    alert("여행 시간을 입력해주세요.");
    return;
  }
  
  // 환승 모드에서만 도착 시간 체크
  if (!isUsingCurrentTime && !document.getElementById("arrival-time").value) {
    alert("환승지 도착 시간을 입력해주세요.");
    return;
  }
  
  // 로딩 인디케이터 표시
  if (loadingOverlay) loadingOverlay.style.display = "flex";
  
  try {
    // 기존에 그려진 경로 제거
    directionsRenderers.forEach(r => r.setMap(null));
    directionsRenderers = [];

    // 상세 정보 컨테이너 초기화
    const detailBox = document.getElementById("route-details");
    detailBox.innerHTML = "<p>최적 경로 계산 중...</p>";

    // 운영 시간 기반 필터링
    const filtered = filterPlacesByLayover(arrivalTime, layoverTime);
    if (!filtered.length) {
      detailBox.innerHTML = `<div class="error-message">
        <h3>방문 가능한 장소가 없습니다</h3>
        <p>선택한 시간대(${arrivalTime.toLocaleString()})에 운영 중인 장소가 없습니다.</p>
        <p>다른 시간대를 선택하거나 다른 장소를 추가해보세요.</p>
      </div>`;
      if (loadingOverlay) loadingOverlay.style.display = "none";
      return;
    }

    // 필터된 리스트로 교체한 뒤 최적 경로 계산
    const validDestinations = filtered;
    
    // 출발지 + 경유지 좌표 배열
    const pts = [currentStartLocation, ...validDestinations.map(p => p.location)];

    // Distance Matrix 요청
    new google.maps.DistanceMatrixService().getDistanceMatrix(
      {
        origins: pts,
        destinations: pts,
        travelMode: "TRANSIT"
      },
      async (resp, st) => {
        if (st !== "OK") {
          detailBox.innerHTML = `<div class="error-message">
            <h3>거리 계산 실패</h3>
            <p>오류: ${st}</p>
            <p>다시 시도해주세요.</p>
          </div>`;
          if (loadingOverlay) loadingOverlay.style.display = "none";
          return;
        }

        // 거리/시간 행렬
        const M = resp.rows.map(r => r.elements);
        // 1…n-1 번 인덱스 순열 생성
        const idx = [...Array(pts.length - 1)].map((_, i) => i + 1);

        // 최적 경로와 시간 초기화
        let best = null, bestTime = Infinity;

        // 브루트포스 순열 탐색 (경로 개수 제한 추가)
        const permutations = getPermutations(idx);
        
        // 순열 계산이 너무 많으면 경고
        if (permutations.length > 5000) {
          console.warn(`많은 경로 계산: ${permutations.length}개`);
        }

        permutations.forEach(p => {
          let t = 0, ok = true, prev = 0;
          p.forEach(i => {
            const e = M[prev][i];
            if (e.status !== "OK") ok = false;
            else t += e.duration.value;
            prev = i;
          });
          const back = M[prev][0];
          if (back.status !== "OK") ok = false;
          else t += back.duration.value;
          if (ok && t < bestTime) {
            bestTime = t;
            best = p;
          }
        });
        
        if (!best) {
          detailBox.innerHTML = `<div class="error-message">
            <h3>경로 계산 실패</h3>
            <p>방문 가능한 경로를 찾을 수 없습니다.</p>
            <p>일부 목적지 사이의 대중교통 연결이 없을 수 있습니다.</p>
            <p>더 적은 목적지를 선택하거나 다른 지역을 시도해보세요.</p>
          </div>`;
          if (loadingOverlay) loadingOverlay.style.display = "none";
          return;
        }

        // 경로 표시: 출발지 → 경유지 순 → 출발지
        let prev = currentStartLocation;
        // 최적화된 순서로 목적지 이름 배열 생성
        const names = [currentStartLocationName || "출발지"];
        // best 배열 순서대로 목적지 이름 추가
        best.forEach(order => {
          names.push(validDestinations[order - 1].name);
        });
        let cIdx = 0;
        
        // 시간 시뮬레이션 변수
        let currentTime = adjustForTimezone(arrivalTime);
        let totalTransitTime = 0;
        let totalStayTime = 0;

        detailBox.innerHTML = "";  // 컨테이너 초기화

        // 경로 및 시간 정보 헤더
        const timeHeader = document.createElement("div");
        timeHeader.className = "time-info-header";
        timeHeader.innerHTML = `
          <h3>환승 일정 개요</h3>
          <p><b>환승 도착:</b> ${currentTime.toLocaleString()}</p>
          <p><b>총 환승 시간:</b> ${formatDuration(layoverTime * 60)}</p>
        `;
        detailBox.appendChild(timeHeader);

        for (const order of [...best, 0]) {
          // 0은 출발지 복귀
          const dest = order === 0
          ? currentStartLocation
          : validDestinations[order - 1].location;

          try {
            // 대중교통 경로 요청
            const res = await getTransitRoute(prev, dest);
            const col = routeColors[cIdx++ % routeColors.length];
            const { bounds, renderer } = displayLegOnMap(res, col);

            // 첫 번째 leg 정보
            const leg = res.routes[0].legs[0];
            
            // 이동 시간 누적
            totalTransitTime += leg.duration.value;
            currentTime = new Date(currentTime.getTime() + leg.duration.value * 1000);

            // 카드 요소 생성
            const card = document.createElement("div");
            card.className = "leg-card";
            card.style.borderLeft = `5px solid ${col}`;

            // 이동 구간 정보 업데이트 (수정된 버전)
            let sourceText, destText;
            
            if (cIdx === 1) {
              // 첫 번째 구간: 출발지 → 첫 번째 목적지
              sourceText = names[0]; // 출발지
              destText = names[1];   // 첫 번째 목적지
            } else if (order === 0) {
              // 마지막 구간: 마지막 목적지 → 출발지(복귀)
              sourceText = names[names.length - 1]; // 마지막 목적지
              destText = names[0] + "(복귀)";        // 출발지(복귀)
            } else {
              // 중간 구간들: 이전 목적지 → 현재 목적지
              const currentIndex = best.indexOf(order) + 1; // best 배열에서의 위치
              sourceText = names[currentIndex - 1];
              destText = names[currentIndex];
            }

            // "이 구간 보기" 버튼
            const focusBtn = document.createElement("button");
            focusBtn.className = "focus-btn";
            focusBtn.textContent = "이 구간 보기";
            focusBtn.onclick = e => {
              e.stopPropagation();
              focusLeg(bounds, renderer, col);
            };

            // "구글맵으로 열기" 버튼
            const gUrl = `https://www.google.com/maps/dir/?api=1`
                       + `&origin=${encodeURIComponent(leg.start_address)}`
                       + `&destination=${encodeURIComponent(leg.end_address)}`
                       + `&travelmode=transit`;
            const gBtn = document.createElement("button");
            gBtn.className = "route-link-btn";
            gBtn.textContent = "구글맵으로 열기";
            gBtn.onclick = e => {
              e.stopPropagation();
              window.open(gUrl, "_blank");
            };

            // 이동 카드: 헤더 + leg 세부 정보
            const moveTime = formatDuration(leg.duration.value);
            card.innerHTML = `
              <h4 style="color:${col};margin:0 0 6px 0;">${sourceText} → ${destText}</h4>
              <p><b>이동 시간:</b> ${moveTime}</p>
              <p><b>도착 예상:</b> ${currentTime.toLocaleString()}</p>
              ${extractLegInfo(leg)}
            `;

            // 버튼들을 카드에 추가
            card.prepend(focusBtn);
            card.appendChild(gBtn);

            // 카드 전체 클릭 시에도 하이라이트
            card.onclick = () => focusLeg(bounds, renderer, col);

            detailBox.appendChild(card);
            
            // 머무는 시간 카드 (마지막 출발지 귀환은 제외)
            if (order !== 0) {
              const poi = validDestinations[order - 1];
              const stayTime = poi.duration * 60; // 초 단위로 변환
              totalStayTime += stayTime;
              
              // 체류 시간 추가
              currentTime = new Date(currentTime.getTime() + stayTime * 1000);
              
              const stayCard = document.createElement("div");
              stayCard.className = "stay-card";
              stayCard.innerHTML = `
                <h4>${poi.name} 체류</h4>
                <p><b>체류 시간:</b> ${formatDuration(stayTime)}</p>
                <p><b>출발 예정:</b> ${currentTime.toLocaleString()}</p>
              `;
              detailBox.appendChild(stayCard);
            }
          } catch (err) {
            const fail = document.createElement("div");
            fail.className = "leg-card error";
            fail.innerHTML = `
              <h4>경로 오류</h4>
              <p>오류 코드: ${err}</p>
              <p>이 구간의 대중교통 경로를 찾을 수 없습니다.</p>
              <p>다른 이동 방식이나 경로를 고려해보세요.</p>
            `;
            detailBox.appendChild(fail);
          }

          prev = dest;
        }

        // 전체 경로 요약 및 총 소요 시간
        const summary = document.createElement("div");
        summary.className = "summary-card";
        summary.innerHTML = `
          <h3>전체 경로 요약</h3>
          <p class="route-summary">${names.join(" → ")}</p>
          <p><b>총 이동 시간:</b> ${formatDuration(totalTransitTime)}</p>
          <p><b>총 체류 시간:</b> ${formatDuration(totalStayTime)}</p>
          <p><b>총 소요 시간:</b> ${formatDuration(totalTransitTime + totalStayTime)}</p>
        `;
        
        // 환승 시간 초과 확인
        const totalTime = totalTransitTime + totalStayTime;
        if (totalTime > layoverTime * 60) {
          summary.innerHTML += `
            <div class="warning-message">
              <p>⚠️ <b>주의:</b> 총 소요 시간(${formatDuration(totalTime)})이 환승 가능 시간(${formatDuration(layoverTime * 60)})을 초과합니다.</p>
              <p>일부 목적지를 제외하거나 체류 시간을 조정해보세요.</p>
            </div>
          `;
        } else {
          const remainingTime = layoverTime * 60 - totalTime;
          summary.innerHTML += `
            <p><b>남은 환승 시간:</b> ${formatDuration(remainingTime)}</p>
          `;
        }
        
        detailBox.appendChild(summary);

        // 최적화된 여행 순서를 전역 변수에 저장 (여행 시작 시 사용)
        window.optimizedJourneyOrder = best.map(order => validDestinations[order - 1]);

        // 06.03 여행 시작 버튼 표시
        toggleStartJourneyButton(true);
      }
    );
  } catch (error) {
    console.error("경로 생성 오류:", error);
    const detailBox = document.getElementById("route-details");
    detailBox.innerHTML = `<div class="error-message">
      <h3>경로 생성 중 오류 발생</h3>
      <p>${error.message || "알 수 없는 오류"}</p>
      <p>다시 시도해주세요.</p>
    </div>`;
  } finally {
    // 로딩 인디케이터 숨기기
    if (loadingOverlay) loadingOverlay.style.display = "none";
  }
}

/* ---------- 지오코딩 ---------- */
function geocodeAddress(addr){
  new google.maps.Geocoder().geocode({address:addr}, (res,st)=>{
    if(st!=="OK") {
      alert("출발지 변환 실패: " + st);
      return;
    }
    const loc = res[0].geometry.location;
    currentStartLocation = loc;
    currentStartLocationName = res[0].formatted_address;
    map.setCenter(loc);
    if(startMarker) startMarker.setMap(null);
    startMarker = createMarker(loc,"출발지","http://maps.google.com/mapfiles/ms/icons/blue-dot.png");
    infowindow.setContent("출발지: " + currentStartLocationName); 
    infowindow.open(map, startMarker);
  });
}

/* ---------- 카테고리 검색 ---------- */
function searchByCategory(loc, type){
  clearCategoryMarkers();
  
  if (loadingOverlay) loadingOverlay.style.display = "flex";
  
  new google.maps.places.PlacesService(map).nearbySearch(
    {location:loc, radius:5000, type},
    (res, st) => {
      const box = document.getElementById("destination-search-results");
      if(st !== "OK" || !res.length) { 
        box.innerHTML = `<p>해당 카테고리 장소를 찾지 못했습니다.</p>`; 
        if (loadingOverlay) loadingOverlay.style.display = "none";
        return; 
      }
      
      const icon = categoryIcons[type] || "http://maps.google.com/mapfiles/ms/icons/ltblue-dot.png";
      
      // 검색 결과 마커 생성 및 지도에 표시
      res.forEach(p => {
        if(p.geometry?.location) {
          const m = new google.maps.Marker({
            map,
            position: p.geometry.location,
            icon,
            title: p.name
          });
          
          // 마커 클릭 시 상세 정보 표시
          m.addListener("click", () => {
            showDestinationModal({ place_id: p.place_id });
          });
          
          categoryMarkers.push(m);
        }
      });
      
      // 검색 결과 표시
      paginateResults(res, box, renderPlaceItem);

      // 결과를 모두 볼 수 있도록 지도 범위 조정
      if (res.length > 0 && res[0].geometry) {
        const bounds = new google.maps.LatLngBounds();
        res.forEach(p => {
          if (p.geometry?.location) {
            bounds.extend(p.geometry.location);
          }
        });
        bounds.extend(loc); // 현재 위치도 포함
        map.fitBounds(bounds);
      }
      
      if (loadingOverlay) loadingOverlay.style.display = "none";
    }
  );
}

/* ---------- 시간 모드 관련 함수들 ---------- */

// 시간 모드 설정 함수 -> 06.07 삭제

// 운영 상태 표시 업데이트
function updateOpenStatusDisplay() {
  // 일정 목록 업데이트
  displayItinerary();
  
  // 현재 검색 결과가 있다면 업데이트
  const searchResults = document.getElementById("destination-search-results");
  if (searchResults && searchResults.children.length > 0) {
    const resultsContainer = searchResults.querySelector(".pagination") || searchResults;
    if (resultsContainer && resultsContainer.querySelector("button")) {
      // 현재 활성화된 페이지 버튼 클릭 (페이지 새로고침)
      const activePage = resultsContainer.querySelector("button[disabled]");
      if (activePage) {
        activePage.click();
      }
    }
  }
}

// 임시 알림 표시 함수
function showTemporaryNotification(message) {
  // 기존 알림 제거
  const existingNotification = document.querySelector('.temporary-notification');
  if (existingNotification) {
    document.body.removeChild(existingNotification);
  }
  
  const notification = document.createElement("div");
  notification.className = "temporary-notification";
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.classList.add("fade-out");
    setTimeout(() => {
      if (notification.parentNode) {
        document.body.removeChild(notification);
      }
    }, 500);
  }, 2000);
}

/* ---------- UI 모드 전환 함수들 (개선된 버전) ---------- */

// 시간 모드 설정 함수 (개선된 버전)
function setTimeMode(useCurrentTime) {
  isUsingCurrentTime = useCurrentTime;
  
  // 버튼 상태 업데이트
  const currentTimeBtn = document.getElementById("current-time-btn");
  const arrivalTimeBtn = document.getElementById("arrival-time-btn");
  
  if (currentTimeBtn && arrivalTimeBtn) {
    currentTimeBtn.classList.toggle("active", useCurrentTime);
    arrivalTimeBtn.classList.toggle("active", !useCurrentTime);
  }
  
  // UI 요소 표시/숨김
  const arrivalTimeForm = document.getElementById("arrival-time-form");
  const layoverTitle = document.getElementById("layover-title");
  const layoverDescription = document.getElementById("layover-description");
  
  if (useCurrentTime) {
    // 현재 시간 모드
    if (arrivalTimeForm) arrivalTimeForm.style.display = "none";
    if (layoverTitle) layoverTitle.textContent = "여행 가능 시간 (분 단위)";
    if (layoverDescription) {
      layoverDescription.textContent = "지금부터 얼마나 오래 여행하실 예정인가요? (최소 30분, 최대 24시간)";
    }
    showTemporaryNotification("현재 시간 기준으로 설정되었습니다.");
  } else {
    // 환승 도착 시간 모드
    if (arrivalTimeForm) arrivalTimeForm.style.display = "block";
    if (layoverTitle) layoverTitle.textContent = "환승 시간 (분 단위)";
    if (layoverDescription) {
      layoverDescription.textContent = "환승 대기 시간 동안 여행하실 시간입니다. (최소 30분, 최대 24시간)";
    }
    showTemporaryNotification("환승 도착 시간 기준으로 설정되었습니다.");
  }
  
  // 표시 업데이트
  updateOpenStatusDisplay();
  
  console.log(`시간 모드 변경: ${useCurrentTime ? '현재 시간' : '환승 도착 시간'}`);
}

// 페이지 로드 시 초기 모드 설정
function initializeTimeMode() {
  // 기본값: 현재 시간 모드
  setTimeMode(true);
  
  // 현재 시간을 환승 시간 입력창에 기본값으로 설정
  const layoverInput = document.getElementById("layover-time");
  if (layoverInput && !layoverInput.value) {
    layoverInput.value = "180"; // 기본 3시간
  }
}

// 현재 시간 모드에서 일정 생성 시 유효성 검사 개선
function validateCurrentTimeMode() {
  if (isUsingCurrentTime) {
    const layoverTime = parseInt(document.getElementById("layover-time").value);
    
    if (!layoverTime || isNaN(layoverTime)) {
      alert("여행 가능 시간을 입력해주세요.");
      return false;
    }
    
    if (layoverTime < 30) {
      alert("최소 30분 이상의 여행 시간이 필요합니다.");
      return false;
    }
    
    if (layoverTime > 1440) {
      alert("최대 24시간(1440분)까지만 설정 가능합니다.");
      return false;
    }
    
    return true;
  }
  
  return true; // 환승 모드는 기존 검증 로직 사용
}

// 현재 시간 모드용 가상 도착 시간 생성
function getCurrentTimeModeArrivalTime() {
  if (isUsingCurrentTime) {
    // 현재 시간을 환승 도착 시간으로 사용
    return new Date();
  }
  
  // 환승 모드는 기존 입력값 사용
  const arrivalInput = document.getElementById("arrival-time");
  return new Date(arrivalInput.value);
}

// 06.03 여행 네비게이션 관련 함수
/* ---------- 여행 네비게이션 관련 함수들 ---------- */

// 여행 네비게이션 상태 변수
let isJourneyActive = false;
let journeyStartTime = null;
let currentDestinationIndex = 0;
let journeyItinerary = [];

// 여행 시작 버튼 표시/숨기기
function toggleStartJourneyButton(show) {
  const startButton = document.getElementById("start-journey-button");
  if (startButton) {
    startButton.style.display = show ? "block" : "none";
  }
}

// 상태 인디케이터 업데이트
function updateStatusIndicator(status, message, nextDestination, timeRemaining) {
  const statusIndicator = document.getElementById("status-indicator");
  const statusIcon = statusIndicator.querySelector(".status-icon");
  const statusText = statusIndicator.querySelector(".status-text");
  const nextDest = statusIndicator.querySelector(".next-destination");
  const timeRem = statusIndicator.querySelector(".time-remaining");
  
  // 상태별 아이콘 및 색상
  switch(status) {
    case 'normal':
      statusIcon.textContent = "🟢";
      statusText.className = "status-text status-normal";
      break;
    case 'warning':
      statusIcon.textContent = "🟡";
      statusText.className = "status-text status-warning";
      break;
    case 'critical':
      statusIcon.textContent = "🔴";
      statusText.className = "status-text status-critical";
      break;
    default:
      statusIcon.textContent = "⚪";
      statusText.className = "status-text";
  }
  
  statusText.textContent = message;
  nextDest.textContent = `다음: ${nextDestination}`;
  timeRem.textContent = `남은 시간: ${timeRemaining}`;
  
  // 표시
  statusIndicator.style.display = "block";
}

// 상세 정보가 포함된 상태 표시기 업데이트
function updateStatusIndicatorWithDetails(status, message, nextDestination, timeRemaining, detailedInfo = '') {
  const statusIndicator = document.getElementById("status-indicator");
  const statusIcon = statusIndicator.querySelector(".status-icon");
  const statusText = statusIndicator.querySelector(".status-text");
  const nextDest = statusIndicator.querySelector(".next-destination");
  const timeRem = statusIndicator.querySelector(".time-remaining");
  
  // 상세 정보 표시 영역 (새로 추가될 부분)
  let detailsArea = statusIndicator.querySelector(".detailed-info");
  
  // 상태별 아이콘 및 색상
  switch(status) {
    case 'normal':
      statusIcon.textContent = "🟢";
      statusText.className = "status-text status-normal";
      break;
    case 'warning':
      statusIcon.textContent = "🟡";
      statusText.className = "status-text status-warning";
      break;
    case 'critical':
      statusIcon.textContent = "🔴";
      statusText.className = "status-text status-critical";
      break;
    default:
      statusIcon.textContent = "⚪";
      statusText.className = "status-text";
  }
  
  statusText.textContent = message;
  nextDest.textContent = `다음: ${nextDestination}`;
  timeRem.textContent = `남은 시간: ${timeRemaining}`;
  
  // 상세 정보 표시 (있는 경우)
  if (detailedInfo && detailsArea) {
    detailsArea.textContent = detailedInfo;
    detailsArea.style.display = 'block';
  } else if (detailsArea) {
    detailsArea.style.display = 'none';
  }
  
  // 표시
  statusIndicator.style.display = "block";
}

// 06.11 여행 상태 인디케이터 고도화
/* ---------- 다음 목적지 상세 정보 함수들 ---------- */

// 다음 목적지까지의 상세 정보 가져오기
async function getNextDestinationDetails(currentPos, nextDestination) {
  if (!currentPos || !nextDestination) {
    return null;
  }

  const userLocation = new google.maps.LatLng(currentPos.lat, currentPos.lng);
  const destLocation = nextDestination.location;

  try {
    // 도보 경로 먼저 확인
    const walkingRoute = await getDirectionsDetails(userLocation, destLocation, 'WALKING');
    
    // 대중교통 경로도 확인 (비교용)
    const transitRoute = await getDirectionsDetails(userLocation, destLocation, 'TRANSIT');

    return {
      walking: walkingRoute,
      transit: transitRoute,
      destination: nextDestination
    };
  } catch (error) {
    console.error("다음 목적지 정보 가져오기 실패:", error);
    return null;
  }
}

// Google Directions API 호출 (Promise 버전)
function getDirectionsDetails(origin, destination, travelMode) {
  return new Promise((resolve, reject) => {
    const directionsService = new google.maps.DirectionsService();
    
    const request = {
      origin: origin,
      destination: destination,
      travelMode: travelMode,
      unitSystem: google.maps.UnitSystem.METRIC
    };

    // 대중교통인 경우 추가 옵션
    if (travelMode === 'TRANSIT') {
      request.transitOptions = {
        departureTime: new Date()
      };
    }

    directionsService.route(request, (result, status) => {
      if (status === 'OK') {
        resolve(result);
      } else {
        reject(status);
      }
    });
  });
}

// 도보 정보 파싱
function parseWalkingInfo(directionsResult) {
  if (!directionsResult || !directionsResult.routes[0]) {
    return null;
  }

  const route = directionsResult.routes[0];
  const leg = route.legs[0];

  return {
    distance: leg.distance.text,
    duration: leg.duration.text,
    steps: leg.steps.map(step => ({
      instruction: step.instructions.replace(/<[^>]*>/g, ''), // HTML 태그 제거
      distance: step.distance.text,
      duration: step.duration.text
    }))
  };
}

// 대중교통 정보 파싱  
function parseTransitInfo(directionsResult) {
  if (!directionsResult || !directionsResult.routes[0]) {
    return null;
  }

  const route = directionsResult.routes[0];
  const leg = route.legs[0];
  const transitSteps = [];

  leg.steps.forEach(step => {
    if (step.travel_mode === 'TRANSIT' && step.transit) {
      const transit = step.transit;
      transitSteps.push({
        type: transit.line.vehicle.type, // BUS, SUBWAY, TRAIN 등
        lineName: transit.line.name,
        lineShortName: transit.line.short_name,
        departureStop: transit.departure_stop.name,
        arrivalStop: transit.arrival_stop.name,
        duration: step.duration.text
      });
    } else if (step.travel_mode === 'WALKING') {
      transitSteps.push({
        type: 'WALKING',
        duration: step.duration.text,
        distance: step.distance.text,
        instruction: step.instructions.replace(/<[^>]*>/g, '')
      });
    }
  });

  return {
    totalDuration: leg.duration.text,
    totalDistance: leg.distance.text,
    steps: transitSteps
  };
}



// 여행 시작
function startJourney() {
  if (!itineraryDestinations.length) {
    alert("먼저 여행 일정을 생성해주세요.");
    return;
  }
  
  const confirmStart = confirm("여행을 시작하시겠습니까?\nGPS 추적이 시작되고 실시간으로 일정을 모니터링합니다.");
  if (!confirmStart) return;
  
  // 여행 상태 초기화
  isJourneyActive = true;
  journeyStartTime = new Date();
  currentDestinationIndex = 0;
  
  // 중요: 최적화된 경로 순서를 가져와야 함
  //journeyItinerary = [...itineraryDestinations]; // 복사본 생성
  // 최적화된 순서가 있으면 사용, 없으면 기존 순서 사용
  journeyItinerary = window.optimizedJourneyOrder || [...itineraryDestinations];

  // UI 업데이트
  toggleStartJourneyButton(false);
  document.getElementById("journey-controls").style.display = "block";
  
  // 초기 상태 표시 - 첫 번째 목적지 표시
  const firstDestination = journeyItinerary[0];
  updateStatusIndicator(
    'normal',
    '여행 시작됨',
    firstDestination?.name || '목적지 없음',
    '계산 중...'
  );
  
  // GPS 추적 시작
  const trackingStarted = startGpsTracking();
  if (!trackingStarted) {
    alert("GPS 추적을 시작할 수 없습니다. 위치 권한을 확인해주세요.");
    isJourneyActive = false;
    return;
  }

  // 네비게이션 모드 활성화 (새로 추가)
  enableNavigationMode();
  
  showTemporaryNotification("여행이 시작되었습니다! 안전한 여행 되세요.");
  console.log("여행 시작:", journeyStartTime);
}

// 여행 일시정지 (수정된 버전)
function pauseJourney() {
  if (!isJourneyActive) return;
  
  const confirmPause = confirm("여행을 일시정지하시겠습니까?\nGPS 추적이 중단됩니다.");
  if (!confirmPause) return;
  
  isJourneyActive = false;
  stopGpsTracking();
  
  // 버튼 상태 변경
  document.getElementById("pause-journey-btn").style.display = "none";
  document.getElementById("resume-journey-btn").style.display = "block";
  
  updateStatusIndicator(
    'warning',
    '여행 일시정지됨',
    '일시정지 중',
    '일시정지'
  );
  
  showTemporaryNotification("여행이 일시정지되었습니다.");
}

// 여행 재개 (새로운 함수)
function resumeJourney() {
  if (isJourneyActive) return;
  
  const confirmResume = confirm("여행을 재개하시겠습니까?\nGPS 추적이 다시 시작됩니다.");
  if (!confirmResume) return;
  
  isJourneyActive = true;
  startGpsTracking();
  
  // 버튼 상태 변경
  document.getElementById("pause-journey-btn").style.display = "block";
  document.getElementById("resume-journey-btn").style.display = "none";
  
  // 현재 목적지 정보로 상태 업데이트
  const currentDest = journeyItinerary[currentDestinationIndex];
  updateStatusIndicator(
    'normal',
    '여행 재개됨',
    currentDest?.name || '목적지 없음',
    '계산 중...'
  );
  
  showTemporaryNotification("여행이 재개되었습니다!");
  console.log("여행 재개:", new Date());
}

// 여행 종료 (수정된 버전)
function stopJourney() {
  if (!isJourneyActive && !journeyStartTime) return;
  
  const confirmStop = confirm("여행을 종료하시겠습니까?\n모든 추적이 중단되고 네비게이션 모드가 해제됩니다.");
  if (!confirmStop) return;
  
  // 상태 리셋
  isJourneyActive = false;
  journeyStartTime = null;
  currentDestinationIndex = 0;
  journeyItinerary = [];
  
  // GPS 추적 중단
  stopGpsTracking();

  // 06.07 네비게이션 모드 비활성화 (새로 추가)
  disableNavigationMode();
  
  // UI 리셋
  document.getElementById("status-indicator").style.display = "none";
  document.getElementById("journey-controls").style.display = "none";
  
  // 버튼 상태 리셋
  document.getElementById("pause-journey-btn").style.display = "block";
  document.getElementById("resume-journey-btn").style.display = "none";
  
  // 여행 시작 버튼 다시 표시 (일정이 있는 경우에만)
  if (itineraryDestinations.length > 0) {
    toggleStartJourneyButton(true);
  }
  
  showTemporaryNotification("여행이 종료되었습니다. 수고하셨습니다!");
  console.log("여행 종료");
}
// 상태 인디케이터 토글 (플로팅 ↔ 고정)
function toggleStatusIndicatorMode() {
  const statusIndicator = document.getElementById("status-indicator");
  statusIndicator.classList.toggle("fixed-mode");
  
  const toggleBtn = statusIndicator.querySelector(".status-toggle");
  toggleBtn.textContent = statusIndicator.classList.contains("fixed-mode") ? "📍" : "📌";
}

/* ---------- 실시간 GPS 추적 함수들 ---------- */

// 실시간 GPS 추적 시작 (구글맵 네비게이션 스타일)
function startGpsTracking() {
  if (!navigator.geolocation) {
    console.error("GPS를 지원하지 않는 브라우저입니다.");
    updateStatusIndicator('critical', 'GPS 미지원', 'GPS 기능 없음', '오류');
    return false;
  }

  if (isTrackingActive) {
    console.log("이미 GPS 추적이 활성화되어 있습니다.");
    return true;
  }

  console.log("🗺️ 실시간 GPS 추적 시작 (네비게이션 모드)");
  isTrackingActive = true;
  
  // 실시간 위치 추적 시작 (구글맵처럼)
  watchId = navigator.geolocation.watchPosition(
    onLocationUpdate,      // 성공 콜백
    onLocationError,       // 오류 콜백
    TRACKING_OPTIONS       // 옵션
  );

  // 추적 시작 알림
  showTemporaryNotification("📍 GPS 추적이 시작되었습니다.");
  return true;
}

// 실시간 GPS 추적 중단
function stopGpsTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  
  isTrackingActive = false;
  currentPosition = null;
  lastLocationUpdate = null;
  
  // 사용자 위치 마커 제거
  if (userLocationMarker) {
    userLocationMarker.setMap(null);
    userLocationMarker = null;
  }
  
  // 정확도 원 제거
  if (window.accuracyCircle) {
    window.accuracyCircle.setMap(null);
    window.accuracyCircle = null;
  }
  
  console.log("🗺️ 실시간 GPS 추적 중단");
  showTemporaryNotification("GPS 추적이 중단되었습니다.");
}

// 위치 업데이트 콜백 (구글맵 네비게이션 스타일)
function onLocationUpdate(position) {
  const newPosition = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    timestamp: new Date(position.timestamp)
  };

  console.log(`📍 위치 업데이트: ${newPosition.lat.toFixed(6)}, ${newPosition.lng.toFixed(6)} (정확도: ${newPosition.accuracy.toFixed(0)}m)`);

  // 이전 위치와 비교하여 의미있는 이동인지 확인 (네비게이션 앱처럼)
  if (isSignificantMovement(currentPosition, newPosition)) {
    currentPosition = newPosition;
    lastLocationUpdate = newPosition.timestamp;
    
    // 지도에 현재 위치 표시 (구글맵 스타일)
    updateUserLocationOnMap(newPosition);
    
    // 위치 기반 로직 실행
    checkDestinationArrival(newPosition);
    //updateJourneyProgress(newPosition);
    // 이렇게 변경:
    updateJourneyProgressEnhanced(newPosition);
  }
}

// 위치 오류 처리
function onLocationError(error) {
  console.error("GPS 추적 오류:", error);
  
  let errorMessage = "위치 추적 중 오류: ";
  let statusType = 'warning';
  
  switch (error.code) {
    case error.PERMISSION_DENIED:
      errorMessage += "위치 권한이 거부되었습니다.";
      statusType = 'critical';
      break;
    case error.POSITION_UNAVAILABLE:
      errorMessage += "위치 정보를 사용할 수 없습니다.";
      break;
    case error.TIMEOUT:
      errorMessage += "위치 요청 시간이 초과되었습니다.";
      break;
    default:
      errorMessage += "알 수 없는 오류입니다.";
  }
  
  updateStatusIndicator(statusType, errorMessage, '오류 발생', '오류');
  showTemporaryNotification(errorMessage);
}

// 의미있는 이동인지 확인 (노이즈 필터링 - 네비게이션 앱 방식)
function isSignificantMovement(oldPos, newPos) {
  if (!oldPos) return true; // 첫 위치는 항상 업데이트
  
  const distance = calculateDistance(
    new google.maps.LatLng(oldPos.lat, oldPos.lng),
    new google.maps.LatLng(newPos.lat, newPos.lng)
  ) * 1000; // km를 m로 변환
  
  // 5m 이상 이동하거나 30초 이상 지났을 때만 업데이트 (부드러운 추적)
  const timeElapsed = newPos.timestamp - oldPos.timestamp;
  return distance > 5 || timeElapsed > 30000;
}

/* ---------- 현재 위치 표시 (구글맵 네비게이션 스타일) ---------- */

// 지도에 현재 위치 표시 (구글맵 네비게이션과 유사한 스타일)
// 06.07 네비게이션 기능 추가 (고도화)
// 지도에 현재 위치 표시 (네비게이션 기능 추가)
function updateUserLocationOnMap(position) {
  const userLocation = new google.maps.LatLng(position.lat, position.lng);
  
  // 이전 위치 저장 (방향 계산용)
  let prevPosition = null;
  if (userLocationMarker) {
    prevPosition = {
      lat: userLocationMarker.getPosition().lat(),
      lng: userLocationMarker.getPosition().lng()
    };
    userLocationMarker.setMap(null);
  }
  
  // 새 사용자 위치 마커 생성 (구글맵 스타일)
  userLocationMarker = new google.maps.Marker({
    position: userLocation,
    map: map,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: '#4285F4',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 3,
      strokeOpacity: 1
    },
    title: "현재 위치",
    zIndex: 1000,
    optimized: false
  });

  // 정확도 원 업데이트
  if (window.accuracyCircle) {
    window.accuracyCircle.setMap(null);
  }
  
  window.accuracyCircle = new google.maps.Circle({
    center: userLocation,
    radius: position.accuracy,
    map: map,
    fillColor: '#4285F4',
    fillOpacity: 0.1,
    strokeColor: '#4285F4',
    strokeOpacity: 0.3,
    strokeWeight: 1,
    zIndex: 999
  });

  // 네비게이션 모드일 때 지도 따라가기
  if (isMapFollowingUser) {
    map.panTo(userLocation);
    
    // 사용자 이동 방향 계산 및 지도 회전
    if (prevPosition) {
      const heading = calculateUserHeading(prevPosition, position);
      if (heading !== null) {
        lastUserHeading = heading;
        smoothMapRotation(heading);
      }
    }
  }

  // 첫 번째 위치 업데이트 시 지도 중심 이동
  if (!lastLocationUpdate) {
    map.panTo(userLocation);
    map.setZoom(16); // 네비게이션에 적합한 줌 레벨
  }
}

/* ---------- 목적지 도착 감지 (네비게이션 스타일) ---------- */

// 목적지 도착 확인 (구글맵 네비게이션처럼)
function checkDestinationArrival(position) {
  if (currentDestinationIndex >= journeyItinerary.length) {
    return; // 모든 목적지 방문 완료
  }

  const currentDest = journeyItinerary[currentDestinationIndex];
  const userLocation = new google.maps.LatLng(position.lat, position.lng);
  const destLocation = currentDest.location;
  
  const distance = calculateDistance(userLocation, destLocation) * 1000; // km를 m로 변환
  
  console.log(`🎯 현재 목적지(${currentDest.name})까지 거리: ${distance.toFixed(1)}m`);
  
  // 방문 감지 반경 내에 도착했는지 확인 (50m - 현실적인 거리)
  if (distance <= VISIT_DETECTION_RADIUS) {
    onDestinationArrived(currentDest, currentDestinationIndex);
  }
}

// 목적지 도착 처리 (구글맵 네비게이션 스타일)
function onDestinationArrived(destination, index) {
  // 이미 방문 처리된 목적지인지 확인
  if (visitedDestinations.includes(index)) {
    return;
  }

  console.log(`🎉 목적지 도착: ${destination.name}`);
  
  // 방문 완료 표시
  visitedDestinations.push(index);
  
  // UI 업데이트 (구글맵 도착 알림처럼)
  markDestinationAsVisited(index);
  
  // 다음 목적지로 이동
  currentDestinationIndex++;
  
  // 도착 알림 (네비게이션 앱처럼)
  showDestinationArrivalNotification(destination);
  
  // 상태 업데이트
  if (currentDestinationIndex < journeyItinerary.length) {
    const nextDest = journeyItinerary[currentDestinationIndex];
    updateStatusIndicator(
      'normal',
      `${destination.name} 도착!`,
      nextDest.name,
      '다음 목적지로 이동'
    );
  } else {
    // 모든 목적지 방문 완료
    updateStatusIndicator(
      'normal',
      '🎉 모든 목적지 방문 완료!',
      '공항으로 복귀',
      '여행 완료'
    );
  }
}

// 목적지 방문 완료 표시 (구글맵 스타일)
function markDestinationAsVisited(index) {
  const itineraryItems = document.querySelectorAll('.itinerary-item');
  if (itineraryItems[index]) {
    itineraryItems[index].style.backgroundColor = '#e8f5e8';
    itineraryItems[index].style.borderLeft = '5px solid #4CAF50';
    itineraryItems[index].style.opacity = '0.8';
    
    // 체크 마크 추가 (구글맵 완료 스타일)
    const checkMark = document.createElement('div');
    checkMark.innerHTML = '✅ 방문 완료';
    checkMark.style.cssText = `
      color: #4CAF50;
      font-weight: bold;
      padding: 5px;
      background: rgba(76, 175, 80, 0.1);
      border-radius: 4px;
      margin-top: 5px;
    `;
    itineraryItems[index].appendChild(checkMark);
  }
}

// 목적지 도착 알림 (네비게이션 앱 스타일)
function showDestinationArrivalNotification(destination) {
  const message = `🎉 ${destination.name}에 도착했습니다!\n즐거운 시간 보내세요.`;
  showTemporaryNotification(message);
  
  // 진동 알림 (모바일에서 - 네비게이션 앱처럼)
  if ('vibrate' in navigator) {
    navigator.vibrate([200, 100, 200, 100, 200]);
  }
}

/* ---------- 여행 진행 상황 업데이트 ---------- */

// 여행 진행 상황 업데이트 (도보 + 대중교통 정보)
async function updateJourneyProgress(position) {
  if (!isJourneyActive || !journeyItinerary.length) {
    return;
  }

  if (currentDestinationIndex >= journeyItinerary.length) {
    return; // 모든 목적지 방문 완료
  }

  const currentDest = journeyItinerary[currentDestinationIndex];
  const userLocation = new google.maps.LatLng(position.lat, position.lng);
  const distance = calculateDistance(userLocation, currentDest.location);
  
  // 기본 정보
  const nextDestName = currentDest.name;
  const distanceText = distance < 1 ? 
    `${Math.round(distance * 1000)}m` : 
    `${distance.toFixed(1)}km`;

  // 상세 정보 가져오기 시도
  try {
    const detailInfo = await getNextDestinationDetails(position, currentDest);
    
    let statusMessage = '여행 진행 중';
    let detailedInfo = '';

    if (detailInfo) {
      // 도보와 대중교통 정보 모두 확인
      const walkingInfo = detailInfo.walking ? parseWalkingInfo(detailInfo.walking) : null;
      const transitInfo = detailInfo.transit ? parseTransitInfo(detailInfo.transit) : null;
      
      // 도보가 더 빠르거나 가까운 경우 도보 우선
      if (walkingInfo && (!transitInfo || shouldPreferWalking(walkingInfo, transitInfo))) {
        detailedInfo = `🚶 도보 ${walkingInfo.distance} (${walkingInfo.duration})`;
        statusMessage = '도보로 이동';
      } 
      // 대중교통이 더 효율적인 경우
      else if (transitInfo) {
        const transitSteps = formatTransitSteps(transitInfo.steps);
        detailedInfo = `🚌 ${transitSteps} (${transitInfo.totalDuration})`;
        statusMessage = '대중교통 이용';
      }
      // 둘 다 없으면 도보 fallback
      else if (walkingInfo) {
        detailedInfo = `🚶 도보 ${walkingInfo.distance} (${walkingInfo.duration})`;
        statusMessage = '도보로 이동';
      }
    }

    // 상태 표시기 업데이트 (상세 정보 포함)
    updateStatusIndicatorWithDetails(
      'normal',
      statusMessage,
      `${nextDestName} (${distanceText})`,
      calculateRemainingTime(),
      detailedInfo
    );

  } catch (error) {
    console.error("상세 정보 업데이트 실패:", error);
    
    // 기본 정보로 fallback
    updateStatusIndicator(
      'normal',
      '여행 진행 중',
      `${nextDestName} (${distanceText})`,
      calculateRemainingTime()
    );
  }
}

// 06.13 
/* ---------- 2단계: 대중교통 정보 고도화 ---------- */

// 개선된 여행 진행 상황 업데이트 (대중교통 포함)
async function updateJourneyProgressEnhanced(position) {
  if (!isJourneyActive || !journeyItinerary.length) {
    return;
  }

  if (currentDestinationIndex >= journeyItinerary.length) {
    return; // 모든 목적지 방문 완료
  }

  const currentDest = journeyItinerary[currentDestinationIndex];
  const userLocation = new google.maps.LatLng(position.lat, position.lng);
  const distance = calculateDistance(userLocation, currentDest.location);
  
  // 기본 정보
  const nextDestName = currentDest.name;
  const distanceText = distance < 1 ? 
    `${Math.round(distance * 1000)}m` : 
    `${distance.toFixed(1)}km`;

  // 상세 정보 가져오기 시도
  try {
    const detailInfo = await getNextDestinationDetails(position, currentDest);
    
    let statusMessage = '여행 진행 중';
    let detailedInfo = '';

    if (detailInfo) {
      // 도보와 대중교통 정보 모두 확인
      const walkingInfo = detailInfo.walking ? parseWalkingInfo(detailInfo.walking) : null;
      const transitInfo = detailInfo.transit ? parseTransitInfo(detailInfo.transit) : null;
      
      console.log("도보 정보:", walkingInfo);
      console.log("대중교통 정보:", transitInfo);
      
      // 대중교통 우선순위 판단
      if (shouldUseTransit(walkingInfo, transitInfo, distance)) {
        // 대중교통 사용
        const transitSteps = formatTransitSteps(transitInfo.steps);
        detailedInfo = `🚌 ${transitSteps} (${transitInfo.totalDuration})`;
        statusMessage = '대중교통 이용';
      } 
      else if (walkingInfo) {
        // 도보 사용
        detailedInfo = `🚶 도보 ${walkingInfo.distance} (${walkingInfo.duration})`;
        statusMessage = '도보로 이동';
      }
      else {
        // 정보 없음
        detailedInfo = '경로 정보 없음';
        statusMessage = '경로 계산 중';
      }
    }

    // 상태 표시기 업데이트 (상세 정보 포함)
    updateStatusIndicatorWithDetails(
      'normal',
      statusMessage,
      `${nextDestName} (${distanceText})`,
      calculateRemainingTime(),
      detailedInfo
    );

  } catch (error) {
    console.error("상세 정보 업데이트 실패:", error);
    
    // 기본 정보로 fallback
    updateStatusIndicator(
      'normal',
      '여행 진행 중',
      `${nextDestName} (${distanceText})`,
      calculateRemainingTime()
    );
  }
}

// 대중교통 vs 도보 판단 (현실적 기준)
function shouldUseTransit(walkingInfo, transitInfo, distanceKm) {
  // 기본 검증
  if (!walkingInfo || !transitInfo) {
    return false; // 대중교통 정보 없으면 도보
  }
  
  // 시간 추출
  const walkingMinutes = extractMinutes(walkingInfo.duration);
  const transitMinutes = extractMinutes(transitInfo.totalDuration);
  
  // 현실적 판단 기준
  
  // 1. 거리가 1km 이상이고 도보 12분 이상이면 대중교통 고려
  if (distanceKm >= 1 && walkingMinutes >= 12) {
    // 2. 대중교통이 도보보다 15분 이상 오래 걸리면 도보 선택
    if (transitMinutes - walkingMinutes > 15) {
      console.log(`도보 선택: 대중교통이 ${transitMinutes - walkingMinutes}분 더 오래 걸림`);
      return false;
    }
    console.log(`대중교통 선택: 거리 ${distanceKm.toFixed(1)}km, 도보 ${walkingMinutes}분`);
    return true;
  }
  
  // 3. 짧은 거리는 도보
  console.log(`도보 선택: 거리 ${distanceKm.toFixed(1)}km, 도보 ${walkingMinutes}분`);
  return false;
}

// 시간에서 분 추출 (예: "6분", "1시간 20분" → 숫자)
function extractMinutes(timeString) {
  if (!timeString) return 999;
  
  // "1 hour 20 mins" 또는 "20 mins" 형태도 처리
  const hourMatch = timeString.match(/(\d+)\s*(시간|hour)/i);
  const minuteMatch = timeString.match(/(\d+)\s*(분|min)/i);
  
  const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
  const minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
  
  return hours * 60 + minutes;
}

// 대중교통 단계를 상세하게 포맷
function formatTransitSteps(steps) {
  if (!steps || !steps.length) {
    return "대중교통 정보 없음";
  }
  
  const transitParts = [];
  let hasTransit = false;
  
  steps.forEach(step => {
    if (step.type === 'WALKING') {
      // 도보 구간 (5분 이상만 표시)
      const walkingMinutes = extractMinutes(step.duration);
      if (walkingMinutes >= 5) {
        transitParts.push(`도보 ${step.duration}`);
      }
    } else if (step.type !== 'WALKING') {
      // 대중교통 구간
      hasTransit = true;
      const vehicleType = getVehicleTypeKorean(step.type);
      let lineName = '';
      
      // 노선명 처리 (상세하게)
      if (step.lineShortName) {
        lineName = step.lineShortName;
      } else if (step.lineName) {
        // 긴 이름에서 핵심 부분 추출
        lineName = step.lineName.replace(/Line|선|호선/gi, '').trim();
        if (lineName.length > 10) {
          lineName = lineName.substring(0, 10) + '...';
        }
      }
      
      if (lineName) {
        transitParts.push(`${vehicleType} ${lineName}`);
      } else {
        transitParts.push(vehicleType);
      }
    }
  });
  
  // 대중교통이 없으면 fallback
  if (!hasTransit) {
    return "대중교통 없음";
  }
  
  // 너무 많은 환승은 간략화
  if (transitParts.length > 3) {
    return `${transitParts.slice(0, 2).join(' → ')} 외 ${transitParts.length - 2}개`;
  }
  
  return transitParts.join(' → ') || "대중교통";
}

// 교통수단 타입을 한국어로 변환 (상세하게)
function getVehicleTypeKorean(type) {
  const typeMap = {
    'SUBWAY': '지하철',
    'BUS': '버스', 
    'TRAIN': '기차',
    'TRAM': '트램',
    'RAIL': '전철',
    'METRO_RAIL': '지하철',
    'HEAVY_RAIL': '전철',
    'COMMUTER_TRAIN': '통근열차',
    'HIGH_SPEED_TRAIN': '고속철',
    'LONG_DISTANCE_TRAIN': '장거리열차',
    'FERRY': '페리',
    'CABLE_CAR': '케이블카',
    'GONDOLA_LIFT': '곤돌라',
    'FUNICULAR': '푸니쿨라'
  };
  
  return typeMap[type] || '대중교통';
}


// 도보 vs 대중교통 우선순위 결정
function shouldPreferWalking(walkingInfo, transitInfo) {
  if (!walkingInfo || !transitInfo) return true;
  
  // 도보 시간 추출 (예: "6분" → 6)
  const walkingMinutes = extractMinutes(walkingInfo.duration);
  const transitMinutes = extractMinutes(transitInfo.totalDuration);
  
  // 도보가 15분 이하이고, 대중교통과 차이가 10분 이하면 도보 우선
  return walkingMinutes <= 15 && (transitMinutes - walkingMinutes) <= 10;
}

// 시간에서 분 추출 (예: "6분", "1시간 20분" → 숫자)
function extractMinutes(timeString) {
  if (!timeString) return 999;
  
  const hourMatch = timeString.match(/(\d+)시간/);
  const minuteMatch = timeString.match(/(\d+)분/);
  
  const hours = hourMatch ? parseInt(hourMatch[1]) : 0;
  const minutes = minuteMatch ? parseInt(minuteMatch[1]) : 0;
  
  return hours * 60 + minutes;
}

// 대중교통 단계를 읽기 쉬운 형태로 포맷
function formatTransitSteps(steps) {
  if (!steps || !steps.length) return "대중교통";
  
  const transitParts = [];
  
  steps.forEach(step => {
    if (step.type === 'WALKING') {
      // 도보 구간은 간단히 표시
      if (step.distance && extractMinutes(step.duration) > 3) {
        transitParts.push(`도보 ${step.duration}`);
      }
    } else if (step.type !== 'WALKING') {
      // 대중교통 구간
      const vehicleType = getVehicleTypeKorean(step.type);
      const lineName = step.lineShortName || step.lineName || '';
      
      if (lineName) {
        transitParts.push(`${vehicleType} ${lineName}`);
      } else {
        transitParts.push(vehicleType);
      }
    }
  });
  
  // 너무 길면 줄임
  if (transitParts.length > 3) {
    return `${transitParts.slice(0, 2).join(' → ')} 외 ${transitParts.length - 2}개`;
  }
  
  return transitParts.join(' → ') || "대중교통";
}

// 교통수단 타입을 한국어로 변환
function getVehicleTypeKorean(type) {
  const typeMap = {
    'SUBWAY': '지하철',
    'BUS': '버스', 
    'TRAIN': '기차',
    'TRAM': '트램',
    'RAIL': '전철',
    'METRO_RAIL': '지하철',
    'HEAVY_RAIL': '전철',
    'COMMUTER_TRAIN': '통근열차',
    'HIGH_SPEED_TRAIN': '고속열차',
    'LONG_DISTANCE_TRAIN': '장거리열차'
  };
  
  return typeMap[type] || '대중교통';
}

// 남은 시간 계산 (간단한 버전)
function calculateRemainingTime() {
  if (!journeyStartTime || !arrivalInput.value || !layoverInput.value) {
    return '계산 중...';
  }

  const arrivalTime = new Date(arrivalInput.value);
  const layoverDuration = parseInt(layoverInput.value) * 60 * 1000; // 분을 밀리초로
  const endTime = new Date(arrivalTime.getTime() + layoverDuration);
  const now = new Date();
  
  const remaining = Math.max(0, Math.floor((endTime - now) / 1000)); // 초 단위
  return formatDuration(remaining);
}

// 06.07 네이베이션 기능 고도화

/* ---------- 네비게이션 지도 동작 함수들 ---------- */

// 네비게이션 모드 활성화
function enableNavigationMode() {
  isMapFollowingUser = true;
  isMapRotationEnabled = true;
  
  // 복귀 버튼 표시
  const recenterBtn = document.getElementById("recenter-map-btn");
  if (recenterBtn) {
    recenterBtn.style.display = "block";
  }
  
  // 지도 드래그 이벤트 리스너 추가
  map.addListener('dragstart', onMapDragStart);
  map.addListener('dragend', onMapDragEnd);
  
  console.log("🧭 네비게이션 모드 활성화");
}

// 네비게이션 모드 비활성화
function disableNavigationMode() {
  isMapFollowingUser = false;
  isMapRotationEnabled = false;
  
  // 복귀 버튼 숨기기
  const recenterBtn = document.getElementById("recenter-map-btn");
  if (recenterBtn) {
    recenterBtn.style.display = "none";
  }
  
  // 지도를 원래대로 (북쪽 위)
  map.setHeading(0);
  
  console.log("🧭 네비게이션 모드 비활성화");
}

// 지도 드래그 시작 시
function onMapDragStart() {
  if (isMapFollowingUser) {
    console.log("🖱️ 사용자가 지도를 드래그 시작 - 자동 추적 일시정지");
    isMapFollowingUser = false;
    
    // 복귀 버튼 강조 표시
    const recenterBtn = document.getElementById("recenter-map-btn");
    if (recenterBtn) {
      recenterBtn.style.backgroundColor = "#ff9800";
      recenterBtn.style.color = "white";
      recenterBtn.style.animation = "pulse 1s infinite";
    }
  }
}

// 지도 드래그 종료 시
function onMapDragEnd() {
  // 3초 후에 자동으로 복귀 버튼 일반 상태로
  if (mapDragTimeout) clearTimeout(mapDragTimeout);
  mapDragTimeout = setTimeout(() => {
    const recenterBtn = document.getElementById("recenter-map-btn");
    if (recenterBtn && !isMapFollowingUser) {
      recenterBtn.style.backgroundColor = "";
      recenterBtn.style.color = "";
      recenterBtn.style.animation = "";
    }
  }, 3000);
}

// 내 위치로 복귀
function recenterMapToUser() {
  if (currentPosition) {
    const userLocation = new google.maps.LatLng(currentPosition.lat, currentPosition.lng);
    
    // 지도 중심 이동
    map.panTo(userLocation);
    
    // 적절한 줌 레벨 설정
    if (map.getZoom() < 16) {
      map.setZoom(16);
    }
    
    // 사용자 따라가기 모드 재활성화
    isMapFollowingUser = true;
    
    // 복귀 버튼 일반 상태로
    const recenterBtn = document.getElementById("recenter-map-btn");
    if (recenterBtn) {
      recenterBtn.style.backgroundColor = "";
      recenterBtn.style.color = "";
      recenterBtn.style.animation = "";
    }
    
    console.log("🎯 지도가 사용자 위치로 복귀");
    showTemporaryNotification("내 위치로 이동했습니다.");
  }
}

// 사용자 방향 계산 (이전 위치와 현재 위치 비교)
function calculateUserHeading(prevPos, currentPos) {
  if (!prevPos || !currentPos) return null;
  
  const lat1 = prevPos.lat * Math.PI / 180;
  const lat2 = currentPos.lat * Math.PI / 180;
  const deltaLng = (currentPos.lng - prevPos.lng) * Math.PI / 180;
  
  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);
  
  let heading = Math.atan2(y, x) * 180 / Math.PI;
  return (heading + 360) % 360; // 0-360도 범위로 변환
}

// 부드러운 지도 회전
function smoothMapRotation(targetHeading) {
  if (!isMapRotationEnabled || !isMapFollowingUser) return;
  
  const currentHeading = map.getHeading() || 0;
  const angleDiff = ((targetHeading - currentHeading + 540) % 360) - 180;
  
  // 각도 차이가 15도 이상일 때만 회전 (노이즈 방지)
  if (Math.abs(angleDiff) > 15) {
    const newHeading = (currentHeading + angleDiff * 0.3) % 360;
    map.setHeading(newHeading);
    console.log(`🧭 지도 회전: ${newHeading.toFixed(1)}도`);
  }
}


/* ---------- 지도 초기화 ---------- */
function initMap(){
  map = new google.maps.Map(document.getElementById("map"), {
    center: {lat:37.5665, lng:126.9780},
    zoom: 13,
    mapTypeControl: true,
    fullscreenControl: true,
    streetViewControl: true
  });
  infowindow = new google.maps.InfoWindow();

  /* 출발지 자동완성 */
  startAutocomplete = new google.maps.places.Autocomplete(
    document.getElementById("start-location"),
    { types: ["geocode", "establishment"] }
  );
  
  startAutocomplete.addListener("place_changed", () => {
    const p = startAutocomplete.getPlace();
    if(!p.geometry) {
      alert("출발지 정보를 찾을 수 없습니다.");
      return;
    }
    currentStartLocation = p.geometry.location;
    currentStartLocationName = p.formatted_address || p.name || "";
    map.setCenter(currentStartLocation);
    if(startMarker) startMarker.setMap(null);
    startMarker = createMarker(currentStartLocation, "출발지", "http://maps.google.com/mapfiles/ms/icons/blue-dot.png");
    infowindow.setContent("출발지: " + currentStartLocationName); 
    infowindow.open(map, startMarker);
  });
  
  document.getElementById("confirm-start-button").onclick = () => {
    const v = document.getElementById("start-location").value.trim();
    if(v) geocodeAddress(v);
  };

  /* 목적지 자동완성 */
  destinationAutocomplete = new google.maps.places.Autocomplete(
    document.getElementById("destination-search"),
    { 
      types: ["geocode", "establishment"],
      fields: [
        "place_id",
        "geometry",
        "name",
        "types",
        "rating",
        "vicinity",
        "opening_hours"
      ]
    }
  );

  // 목적지 자동완성 결과 선택 시 모달 바로 열기
  destinationAutocomplete.addListener("place_changed", () => {
    const p = destinationAutocomplete.getPlace();
    if (!p.geometry) {
      alert("장소 정보를 찾을 수 없습니다.");
      return;
    }
    map.setCenter(p.geometry.location);
    map.setZoom(15);
    showDestinationModal({ place_id: p.place_id });

    // 검색 결과 영역 업데이트
    document.getElementById("destination-search-results").innerHTML = "";
    document.getElementById("destination-search-results").appendChild(renderPlaceItem(p));
    createMarker(p.geometry.location, p.name, "http://maps.google.com/mapfiles/ms/icons/yellow-dot.png");
  });

  /* 카테고리 검색 */
  document.querySelectorAll(".category-button").forEach(btn => {
    btn.onclick = () => { 
      if(!currentStartLocation) {
        alert("먼저 출발지를 설정해주세요.");
        return;
      }
      searchByCategory(currentStartLocation, btn.dataset.type);
    };
  });

  /* 일정 생성 */
  document.getElementById("generate-route-button").onclick = generateOptimalRoute;
  
  // Sortable 초기화 (일정 목록 드래그 앤 드롭)
  if (typeof Sortable !== 'undefined') {
    const itineraryList = document.getElementById('itinerary-list');
    if (itineraryList) {
      new Sortable(itineraryList, {
        animation: 150,
        ghostClass: 'dragging',
        onEnd: function() {
          // 순서 업데이트 로직은 displayItinerary에서 구현
        }
      });
    }
  }
  
  // 시간 모드 토글 기능 (수정된 버전)
  const currentTimeBtn = document.getElementById("current-time-btn");
  const arrivalTimeBtn = document.getElementById("arrival-time-btn");
  
  if (currentTimeBtn && arrivalTimeBtn) {
    currentTimeBtn.addEventListener("click", function() {
      setTimeMode(true);
    });
    arrivalTimeBtn.addEventListener("click", function() {
      setTimeMode(false);
    });
  }
  
  // 초기 시간 모드 설정 (새로 추가)
  initializeTimeMode();
  
  // 환승 시간 입력 시 알림 (개선된 버전)
  if (arrivalInput) {
    arrivalInput.addEventListener("change", function() {
      if (this.value && !isUsingCurrentTime) {
        updateOpenStatusDisplay();
        showTemporaryNotification("환승 도착 시간이 설정되었습니다.");
      }
    });
  }

  // 여행 시간 입력 시 실시간 유효성 검사 (새로 추가)
  const layoverInput = document.getElementById("layover-time");
  if (layoverInput) {
    layoverInput.addEventListener("input", function() {
      const value = parseInt(this.value);
      const warningArea = document.getElementById("layover-warning");
      
      // 기존 경고 제거
      if (warningArea) warningArea.remove();
      
      if (value && (value < 30 || value > 1440)) {
        const warning = document.createElement("small");
        warning.id = "layover-warning";
        warning.style.color = "#f44336";
        warning.textContent = value < 30 ? 
          "⚠️ 최소 30분 이상 설정해주세요." : 
          "⚠️ 최대 24시간(1440분)까지 설정 가능합니다.";
        this.parentNode.appendChild(warning);
      }
    });
  }

  // 06.03 GPS 버튼 이벤트 리스너
  const gpsButton = document.getElementById("gps-location-button");
  if (gpsButton) {
    gpsButton.addEventListener("click", getCurrentLocation);
  }
  // 여행 네비게이션 버튼 이벤트 리스너
  const startJourneyBtn = document.getElementById("start-journey-button");
  const pauseJourneyBtn = document.getElementById("pause-journey-btn");
  const resumeJourneyBtn = document.getElementById("resume-journey-btn"); // 새로 추가
  const stopJourneyBtn = document.getElementById("stop-journey-btn");
  const statusToggle = document.querySelector(".status-toggle");

  if (startJourneyBtn) {
    startJourneyBtn.addEventListener("click", startJourney);
  }

  if (pauseJourneyBtn) {
    pauseJourneyBtn.addEventListener("click", pauseJourney);
  }

  if (resumeJourneyBtn) { // 새로 추가
    resumeJourneyBtn.addEventListener("click", resumeJourney);
  }

  if (stopJourneyBtn) {
    stopJourneyBtn.addEventListener("click", stopJourney);
  }

  if (statusToggle) {
    statusToggle.addEventListener("click", toggleStatusIndicatorMode);
  }

  // 06.07 복귀 버튼 이벤트 리스너 (새로 추가)
  const recenterBtn = document.getElementById("recenter-map-btn");
  if (recenterBtn) {
    recenterBtn.addEventListener("click", recenterMapToUser);
  }

  // 목적지 검색창 X 버튼 기능 (새로 추가)
  setupSearchClearButton();

  // 로딩 오버레이 초기 숨김
  if (loadingOverlay) loadingOverlay.style.display = "none";
}

// 06.07 검색창 지우기 버튼 추가 (모바일 환경)
/* ---------- 검색창 X 버튼 기능 (간단 버전) ---------- */

function setupSearchClearButton() {
  const searchInput = document.getElementById("destination-search");
  const clearBtn = document.getElementById("clear-search-btn");
  
  if (!searchInput || !clearBtn) return;
  
  // 입력할 때 X 버튼 보이기
  searchInput.addEventListener("input", function() {
    clearBtn.style.display = this.value.length > 0 ? "flex" : "none";
  });
  
  // X 버튼 클릭 시 검색창 비우기
  clearBtn.addEventListener("click", function() {
    searchInput.value = "";
    clearBtn.style.display = "none";
    document.getElementById("destination-search-results").innerHTML = "";
  });
}


// 06.03 gps 관련 추가
/* ---------- GPS 관련 함수들 ---------- */

// 향상된 GPS 위치 획득 함수 (다중 시도 + 정확도 개선)
function getCurrentLocation() {
  const gpsButton = document.getElementById("gps-location-button");
  
  if (!navigator.geolocation) {
    alert("이 브라우저는 위치 서비스를 지원하지 않습니다.");
    return;
  }
  
  // 버튼 상태 변경
  gpsButton.disabled = true;
  gpsButton.classList.add("gps-loading");
  gpsButton.innerHTML = "📍 정확한 위치 확인 중...";
  
  // 개선된 GPS 옵션
  const options = {
    enableHighAccuracy: true,
    timeout: 30000,          // 30초 대기
    maximumAge: 0           // 캐시 사용 안함
  };
  
  let positionAttempts = [];
  let attemptCount = 0;
  const maxAttempts = 3;
  
  function attemptLocationCapture() {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        positionAttempts.push({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp
        });
        
        attemptCount++;
        
        if (attemptCount < maxAttempts && position.coords.accuracy > 100) {
          // 정확도가 100m보다 낮으면 재시도
          console.log(`위치 시도 ${attemptCount}: 정확도 ${position.coords.accuracy}m - 재시도 중...`);
          gpsButton.innerHTML = `📍 위치 확인 중... (${attemptCount}/${maxAttempts})`;
          setTimeout(attemptLocationCapture, 2000); // 2초 후 재시도
        } else {
          // 최적의 위치 선택
          processBestLocation(positionAttempts);
        }
      },
      (error) => {
        attemptCount++;
        if (attemptCount < maxAttempts) {
          console.log(`위치 시도 ${attemptCount} 실패 - 재시도 중...`);
          gpsButton.innerHTML = `📍 위치 확인 중... (${attemptCount}/${maxAttempts})`;
          setTimeout(attemptLocationCapture, 2000);
        } else {
          handleGpsError(error);
          resetGpsButton();
        }
      },
      options
    );
  }
  
  // 첫 번째 시도 시작
  attemptLocationCapture();
}

// 최적의 위치 선택 함수 (새로 추가)
function processBestLocation(positions) {
  if (!positions.length) {
    alert("위치를 가져올 수 없습니다.");
    resetGpsButton();
    return;
  }
  
  // 가장 정확한 위치 선택 (accuracy가 가장 낮은 것)
  const bestPosition = positions.reduce((best, current) => 
    current.accuracy < best.accuracy ? current : best
  );
  
  console.log(`최적 위치 선택: 정확도 ${bestPosition.accuracy}m (${positions.length}번 시도 중)`);
  
  // 개선된 정확도 임계값
  let warningMessage = '';
  
  if (bestPosition.accuracy > 500) {
    warningMessage = `위치 정확도가 매우 낮습니다 (오차: ${Math.round(bestPosition.accuracy)}m).\n실내에서는 정확도가 떨어질 수 있습니다.\n그래도 사용하시겠습니까?`;
  } else if (bestPosition.accuracy > 200) {
    warningMessage = `위치 정확도가 낮습니다 (오차: ${Math.round(bestPosition.accuracy)}m).\n그래도 사용하시겠습니까?`;
  }
  
  if (warningMessage) {
    const useAnyway = confirm(warningMessage);
    if (!useAnyway) {
      resetGpsButton();
      return;
    }
  }
  
  // Google Maps LatLng 객체 생성
  const location = new google.maps.LatLng(bestPosition.lat, bestPosition.lng);
  
  // 역지오코딩으로 주소 가져오기
  reverseGeocode(location);
}

// 역지오코딩: 좌표를 주소로 변환
function reverseGeocode(location) {
  const geocoder = new google.maps.Geocoder();
  
  geocoder.geocode({ location: location }, (results, status) => {
    if (status === "OK" && results[0]) {
      const address = results[0].formatted_address;
      
      // 사용자에게 확인 요청
      const confirmUse = confirm(
        `현재 위치가 감지되었습니다:\n${address}\n\n이 위치를 출발지로 설정하시겠습니까?`
      );
      
      if (confirmUse) {
        // 출발지로 설정
        setStartLocationByGps(location, address);
      }
    } else {
      console.error("역지오코딩 실패:", status);
      // 주소를 가져올 수 없어도 좌표는 사용할 수 있음
      const confirmUse = confirm(
        `현재 위치를 감지했지만 주소를 확인할 수 없습니다.\n좌표 정보로 출발지를 설정하시겠습니까?`
      );
      
      if (confirmUse) {
        setStartLocationByGps(location, `위도: ${location.lat().toFixed(6)}, 경도: ${location.lng().toFixed(6)}`);
      }
    }
    
    resetGpsButton();
  });
}

// GPS로 가져온 위치를 출발지로 설정
function setStartLocationByGps(location, address) {
  // 전역 변수 업데이트
  currentStartLocation = location;
  currentStartLocationName = address;
  
  // 입력창에 주소 표시
  document.getElementById("start-location").value = address;
  
  // 지도 중심 이동
  map.setCenter(location);
  map.setZoom(15);
  
  // 기존 출발지 마커 제거
  if (startMarker) {
    startMarker.setMap(null);
  }
  
  // 새 출발지 마커 생성
  startMarker = createMarker(
    location, 
    "출발지 (GPS)", 
    "http://maps.google.com/mapfiles/ms/icons/blue-dot.png"
  );
  
  // 정보창 표시
  infowindow.setContent(`출발지 (GPS): ${address}`);
  infowindow.open(map, startMarker);
  
  // 성공 알림
  showTemporaryNotification("GPS로 출발지가 설정되었습니다.");
  
  console.log("GPS 출발지 설정 완료:", address);
}

// GPS 오류 처리
function handleGpsError(error) {
  let errorMessage = "위치를 가져올 수 없습니다. ";
  
  switch (error.code) {
    case error.PERMISSION_DENIED:
      errorMessage += "위치 권한이 거부되었습니다. 브라우저 설정에서 위치 권한을 허용해주세요.";
      break;
    case error.POSITION_UNAVAILABLE:
      errorMessage += "위치 정보를 사용할 수 없습니다.";
      break;
    case error.TIMEOUT:
      errorMessage += "위치 요청 시간이 초과되었습니다. 다시 시도해주세요.";
      break;
    default:
      errorMessage += "알 수 없는 오류가 발생했습니다.";
      break;
  }
  
  alert(errorMessage);
}

// GPS 버튼 상태 리셋
function resetGpsButton() {
  const gpsButton = document.getElementById("gps-location-button");
  gpsButton.disabled = false;
  gpsButton.classList.remove("gps-loading");
  gpsButton.innerHTML = "📍 현재 위치 사용";
}

/* ---------- 콜백 ---------- */
window.initMap = initMap;
