-- ROOK — close out existing foreign jobs already in the database
-- Uses the same two-part logic as backend/matching.js's
-- mentionsNonUsCountry: (1) positive longitude (Eastern Hemisphere -
-- the entire US, including Alaska/Hawaii/Puerto Rico, is Western
-- Hemisphere), (2) location text naming a foreign country or major
-- foreign city. Closes rather than deletes, consistent with how other
-- cleanup migrations tonight handled it - reversible, and matches
-- archiveOldJobs.js's normal permanent-deletion timeline (90 days
-- closed) rather than deleting immediately.
--
-- Safe to run anytime. Run the SELECT first if you want to preview
-- what this will affect before running the UPDATE.

-- Preview first (recommended):
-- select id, company_name, title_original, location_raw, job_lng
-- from jobs
-- where status = 'active'
--   and (
--     job_lng > 0
--     or location_raw ~* '\y(china|india|germany|united kingdom|canada|mexico|brazil|france|japan|australia|singapore|spain|italy|netherlands|switzerland|ireland|poland|sweden|belgium|south korea|taiwan|hong kong|philippines|vietnam|thailand|malaysia|indonesia|south africa|israel|turkey|argentina|colombia|chile|portugal|austria|denmark|norway|finland|czech republic|romania|hungary|greece|new zealand|united arab emirates|saudi arabia|egypt|russia|mumbai|bangalore|bengaluru|delhi|new delhi|hyderabad|pune|chennai|gurgaon|gurugram|noida|kolkata|shanghai|beijing|shenzhen|guangzhou|manila|jakarta|kuala lumpur|bangkok|ho chi minh city|hanoi|seoul|tokyo|osaka|sao paulo|mexico city|dubai|tel aviv)\y'
--   );

update jobs
set status = 'closed'
where status = 'active'
  and (
    job_lng > 0
    or location_raw ~* '\y(china|india|germany|united kingdom|canada|mexico|brazil|france|japan|australia|singapore|spain|italy|netherlands|switzerland|ireland|poland|sweden|belgium|south korea|taiwan|hong kong|philippines|vietnam|thailand|malaysia|indonesia|south africa|israel|turkey|argentina|colombia|chile|portugal|austria|denmark|norway|finland|czech republic|romania|hungary|greece|new zealand|united arab emirates|saudi arabia|egypt|russia|mumbai|bangalore|bengaluru|delhi|new delhi|hyderabad|pune|chennai|gurgaon|gurugram|noida|kolkata|shanghai|beijing|shenzhen|guangzhou|manila|jakarta|kuala lumpur|bangkok|ho chi minh city|hanoi|seoul|tokyo|osaka|sao paulo|mexico city|dubai|tel aviv)\y'
  );
